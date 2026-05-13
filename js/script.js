/**
 * PAYPROTEC GATEKEEPER 
 */
const parseBool = (val) => (val === true || val === "true" || val === "TRUE");

// ── RLS SESSION SYNC ──────────────────────────────────────────────────────────
// After the API validates a user, we call this to register the userid
// with the Supabase session so all RLS policies work correctly.
// Non-blocking: if supabase isn't ready or the call fails, login still proceeds.
async function syncRLSSession(userId) {
    if (!userId) return;
    try {
        if (typeof supabase === 'undefined' || !supabase) return;
        await supabase.rpc('set_app_user_id', { p_user_id: userId });
    } catch (err) {
        console.warn('RLS session sync failed (non-critical):', err);
    }
}

async function initGatekeeper() {
    try {
        const params = new URLSearchParams(window.location.search);
        const urlUserId = params.get('userid');
        let cachedUserId = localStorage.getItem('pp_userid');

        if (urlUserId && cachedUserId && urlUserId !== cachedUserId) {
            localStorage.clear();
            window.location.href = window.location.pathname + '?userid=' + urlUserId;
            return;
        }

        const userId = urlUserId || cachedUserId;
        if (!userId) { showLoginUI(); return; }

        const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: userId, action: 'validate' })
        });
        const result = await response.json();

        if (result.success && result.user) {
            // ✅ NEW: Sync RLS session so Supabase queries from this page are authorized
            await syncRLSSession(result.user.userid);
            authorizeUser(result.user);
        } else {
            localStorage.clear();
            showLoginUI();
        }
    } catch (err) {
        console.error("Gatekeeper Critical Error:", err);
        showLoginUI();
    }
}

/**
 * GLOBAL ACTIVITY LOGGER
 * Records actions into the activity_logs table via the API
 */
async function recordActivity(action, statusDetails) {
    const firstName = localStorage.getItem('pp_user_first_name') || '';
    const lastName  = localStorage.getItem('pp_user_last_name')  || '';
    const email     = localStorage.getItem('pp_user_email')       || '';
    const fullName  = [firstName, lastName].filter(Boolean).join(' ') || email || 'System';
    try {
        await fetch('/api/logs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: fullName,
                action: action,
                status: statusDetails
            })
        });
    } catch (err) {
        console.error("Audit Logging Failed:", err);
    }
}

async function checkGlobalNotifications() {
    const uid = localStorage.getItem('pp_userid');
    const badge = document.getElementById('nav-msg-badge');
    if (!uid || !badge) return;

    const { count, error } = await supabase
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .eq('recipient_id', uid)
        .eq('is_read', false);

    if (!error && count > 0) {
        badge.innerText = count > 99 ? '99+' : count;
        badge.style.display = 'block';
    }

    supabase.channel('global-notifications').on('postgres_changes', { 
        event: 'INSERT', schema: 'public', table: 'messages', filter: `recipient_id=eq.${uid}` 
    }, (payload) => {
        const currentCount = parseInt(badge.innerText) || 0;
        badge.innerText = currentCount + 1;
        badge.style.display = 'block';
    }).subscribe();
}

function showLoginUI() {
    const loader = document.getElementById('initial-loader');
    const loginUI = document.getElementById('login-ui');
    if (loader) loader.style.display = 'none';
    if (loginUI) loginUI.style.display = 'block';
}

async function authorizeUser(user) {
    if (!user) return;
    try {
        const deviceToken = localStorage.getItem('pp_device_token');
        localStorage.clear();
        if(deviceToken) localStorage.setItem('pp_device_token', deviceToken);

        localStorage.setItem('pp_userid', user.userid || '');
        localStorage.setItem('pp_role', user.role || 'Regular User');
        localStorage.setItem('pp_verified', 'true');
        localStorage.setItem('pp_user_first_name', user.first_name || 'Sir');
        localStorage.setItem('pp_user_email', user.email || '');
        localStorage.setItem('pp_user_last_name', user.last_name || '');
        localStorage.setItem('userid', user.userid || '');
        localStorage.setItem('pp_can_delete_tickets', user.can_delete_tickets ? 'true' : 'false');
        await new Promise(r => setTimeout(r, 100));
    } catch (e) { console.error("Storage Error:", e); }

    // Bootstrap timezone from business profile (non-blocking)
    fetch('/api/business-profile?userid=' + (user.userid || ''))
        .then(r => r.json())
        .then(r => { if (r.success && r.data?.timezone) localStorage.setItem('pp_tz', r.data.timezone); })
        .catch(() => {});

    // --- 1. ROLE LOGIC ---
    const roleStr = (user.role || "").toLowerCase().trim();
    const isSuperAdmin = roleStr === 'super_admin';
    const isAdmin = roleStr === 'admin' || roleStr === 'operations admin' || isSuperAdmin;

    const elements = {
        loader: document.getElementById('initial-loader'),
        loginUI: document.getElementById('login-ui'),
        curtain: document.getElementById('page-curtain'),
        greeting: document.getElementById('user-greeting'),
        logoutBtn: document.getElementById('logout-btn'),
        secretDungeon: document.getElementById('card-secret'),
        jarvisBtn: document.getElementById('jarvis-trigger'),
        jarvisSidebar: document.getElementById('jarvis-sidebar')
    };

    if (elements.loader) elements.loader.style.display = 'none';
    if (elements.loginUI) elements.loginUI.style.display = 'none';
    if (elements.curtain) elements.curtain.style.display = 'block';
    if (user.first_name && elements.greeting) elements.greeting.innerText = `WELCOME, ${user.first_name.toUpperCase()}`;
    if (elements.logoutBtn) elements.logoutBtn.style.display = 'inline-block';

    // --- 2. JARVIS ACTIVATION ---
    const hasJarvisAccess = isSuperAdmin || parseBool(user.access_jarvis);
    if (hasJarvisAccess && elements.jarvisBtn && elements.jarvisSidebar) {
        elements.jarvisBtn.style.display = 'block';
        elements.jarvisSidebar.style.display = 'flex'; 
        console.log("🤖 Jarvis Online.");
    } else {
        if (elements.jarvisBtn) elements.jarvisBtn.style.display = 'none';
        if (elements.jarvisSidebar) elements.jarvisSidebar.style.display = 'none';
    }
    
    // Manage General Admin Cards
    const hasAdminDashAccess = isAdmin || parseBool(user.access_admin_dashboard);
    if (document.getElementById('card-cms')) document.getElementById('card-cms').style.display = isAdmin ? 'flex' : 'none';
    if (document.getElementById('card-logs')) document.getElementById('card-logs').style.display = isAdmin ? 'flex' : 'none';
    if (document.getElementById('card-admin-dashboard')) document.getElementById('card-admin-dashboard').style.display = hasAdminDashAccess ? 'flex' : 'none';

    // --- 3. THE DUNGEON LOCKDOWN ---
    if (elements.secretDungeon) {
        if (isSuperAdmin) {
            elements.secretDungeon.classList.remove('slds-hide');
            elements.secretDungeon.style.display = 'flex';
        } else {
            elements.secretDungeon.remove();
        }
    }

    // --- 4. PERMISSION OVERRIDE ---
    const permMap = {
        'card-inventory': isSuperAdmin || parseBool(user.access_inventory),
        'card-deployments': isSuperAdmin || parseBool(user.access_deployments),
        'card-returns': isSuperAdmin || parseBool(user.access_returns),
        'card-merchants': isSuperAdmin || parseBool(user.access_merchants),
        'card-partners': isSuperAdmin || parseBool(user.access_partners)
    };

    Object.keys(permMap).forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = permMap[id] ? 'flex' : 'none';
    });
    
    if (window.Swal) Swal.close();
    if (typeof checkGlobalNotifications === 'function') checkGlobalNotifications();
}

function openSecretDungeon() {
    Swal.fire({
        title: '<span style="color:#4338ca; font-weight:800;">SECRET DUNGEON</span>',
        html: `
            <div style="text-align: left; font-size: 13px;">
                <div style="background: white; border: 1px solid #e2e8f0; border-radius: 12px; padding: 15px; margin-bottom:15px;">
                    <strong style="color: #1e293b; display: block; margin-bottom: 5px;">Bulk Merchant Note Injector</strong>
                    <button onclick="triggerBulkNoteUpload()" class="slds-button slds-button_brand" style="width: 100%; background: #6366f1;">
                        UPLOAD CSV
                    </button>
                </div>

                <div style="background: #0f172a; border: 1px solid #38bdf8; border-radius: 12px; padding: 15px; color: white;">
                    <strong style="color: #38bdf8; display: block; margin-bottom: 5px;">JARVIS NEURAL TRAINING</strong>
                    <input type="text" id="train-topic" placeholder="Topic (e.g. Return Policy)" style="width:100%; margin-bottom:8px; padding:8px; border-radius:4px; border:none; color:black;">
                    <textarea id="train-logic" placeholder="The factual truth..." style="width:100%; height:60px; margin-bottom:8px; padding:8px; border-radius:4px; border:none; color:black;"></textarea>
                    <button onclick="submitTraining()" class="slds-button" style="width: 100%; background: #38bdf8; color: #0f172a; font-weight:bold;">
                        INJECT KNOWLEDGE
                    </button>
                </div>
            </div>
        `,
        showConfirmButton: false,
        showCancelButton: true,
        cancelButtonText: 'CLOSE PORTAL'
    });
}

async function submitTraining() {
    const topic = document.getElementById('train-topic').value;
    const logic = document.getElementById('train-logic').value;

    if (!topic || !logic) return Swal.showValidationMessage('Both fields are required');

    Swal.fire({ title: 'Injecting...', didOpen: () => Swal.showLoading() });

    try {
        const res = await fetch('/api/train-jarvis', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                topic: topic, 
                logic: logic,
                userId: localStorage.getItem('pp_userid')
            })
        });
        
        const result = await res.json();
        if (result.success) {
            Swal.fire('Success', 'Knowledge injected into core memory.', 'success');
        } else {
            throw new Error(result.message);
        }
    } catch (e) {
        Swal.fire('Error', `Injection failed: ${e.message}`, 'error');
    }
}

async function triggerBulkNoteUpload() {
    const { value: file } = await Swal.fire({
        title: 'Select CSV File',
        input: 'file',
        inputAttributes: { 'accept': '.csv' }
    });

    if (file) {
        const reader = new FileReader();
        reader.onload = async (e) => {
            const text = e.target.result;
            const allRows = text.split('\n').filter(r => r.trim());
            if (allRows.length < 2) {
                return Swal.fire('Error', 'CSV file is empty or has no data rows.', 'error');
            }

            const headerRow = allRows[0].split(',').map(h => h.trim().toLowerCase());
            const expectedHeaders = ['merchant_id', 'title', 'body'];
            const missingHeaders = expectedHeaders.filter(h => !headerRow.includes(h));
            if (missingHeaders.length > 0) {
                return Swal.fire('Error', `CSV is missing required columns: ${missingHeaders.join(', ')}. Expected headers: merchant_id, title, body`, 'error');
            }

            const midIdx = headerRow.indexOf('merchant_id');
            const titleIdx = headerRow.indexOf('title');
            const bodyIdx = headerRow.indexOf('body');

            const notes = allRows.slice(1).map(r => {
                const cols = r.split(',');
                return {
                    merchant_id: cols[midIdx]?.trim(),
                    title: cols[titleIdx]?.trim(),
                    body: cols[bodyIdx]?.trim()
                };
            }).filter(n => n.merchant_id);

            if (notes.length === 0) {
                return Swal.fire('Error', 'No valid rows found. Ensure merchant_id column is populated.', 'error');
            }

            Swal.fire({ title: 'Injecting...', didOpen: () => Swal.showLoading() });

            const res = await fetch('/api/bulk-notes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ notes, author: localStorage.getItem('pp_userid') })
            });
            const result = await res.json();
            Swal.fire('Hack Success', `Added: ${result.success} | Failed: ${result.failed}`, 'success');
        };
        reader.readAsText(file);
    }
}

async function handleManualLogin() {
    const email = document.getElementById('login-email').value;
    const pass = document.getElementById('login-pass').value;
    const storedToken = localStorage.getItem('pp_device_token');

    if (!email || !pass) return;
    Swal.fire({ title: 'Authenticating...', didOpen: () => Swal.showLoading() });

    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'login', email: email, passkey: pass, deviceToken: storedToken })
        });
        const result = await response.json();

        if (result.success) {
            if (result.needs2FA) {
                Swal.close();
                
                const { value: tfaCode, isConfirmed } = await Swal.fire({
                    title: 'Verify Your Identity',
                    html: `
                        <p style="color: #64748b; margin-bottom: 20px;">Enter the 6-digit code sent to your email.</p>
                        <div class="tfa-input-wrapper" id="tfa-inputs">
                            <input type="text" class="tfa-box" maxlength="1" pattern="[0-9]*" inputmode="numeric">
                            <input type="text" class="tfa-box" maxlength="1" pattern="[0-9]*" inputmode="numeric">
                            <input type="text" class="tfa-box" maxlength="1" pattern="[0-9]*" inputmode="numeric">
                            <input type="text" class="tfa-box" maxlength="1" pattern="[0-9]*" inputmode="numeric">
                            <input type="text" class="tfa-box" maxlength="1" pattern="[0-9]*" inputmode="numeric">
                            <input type="text" class="tfa-box" maxlength="1" pattern="[0-9]*" inputmode="numeric">
                        </div>
                        <div style="margin-top: 25px;">
                            <label style="cursor:pointer; font-size: 14px; color: #1e293b;">
                                <input type="checkbox" id="remember-device"> Remember this device for 30 days
                            </label>
                        </div>
                    `,
                    didOpen: () => {
                        const inputs = document.querySelectorAll('.tfa-box');
                        inputs[0].focus();
                        
                        inputs[0].addEventListener('paste', (e) => {
                            e.preventDefault();
                            const data = e.clipboardData.getData('text').trim();
                            if (/^\d{6}$/.test(data)) {
                                const digits = data.split('');
                                digits.forEach((digit, i) => {
                                    if (inputs[i]) inputs[i].value = digit;
                                });
                                inputs[5].focus();
                            }
                        });

                        inputs.forEach((input, index) => {
                            input.addEventListener('input', (e) => {
                                if (e.target.value && index < 5) inputs[index + 1].focus();
                            });
                            input.addEventListener('keydown', (e) => {
                                if (e.key === 'Backspace' && !e.target.value && index > 0) {
                                    inputs[index - 1].focus();
                                }
                            });
                        });
                    },
                    preConfirm: () => {
                        const code = Array.from(document.querySelectorAll('.tfa-box')).map(i => i.value).join('');
                        if (code.length < 6) {
                            Swal.showValidationMessage('Please enter all 6 digits');
                            return false;
                        }
                        return code;
                    },
                    showCancelButton: true,
                    confirmButtonText: 'Verify Account',
                    confirmButtonColor: '#004990'
                });

                if (isConfirmed && tfaCode) {
                    const remember = document.getElementById('remember-device').checked;
                    verify2FACode(result.userid, tfaCode, remember);
                }
            } else {
                // ✅ NEW: Sync RLS session after direct login (trusted device / no 2FA)
                await syncRLSSession(result.user?.userid);
                authorizeUser(result.user);
            }
        } else {
            Swal.fire('Error', result.message || 'Invalid credentials.', 'error');
        }
    } catch (err) { 
        console.error(err); 
        Swal.fire('Error', 'Connection failed', 'error'); 
    }
}

async function verify2FACode(uid, code, remember) {
    Swal.fire({ title: 'Verifying...', didOpen: () => Swal.showLoading() });
    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'verify2FA', userId: uid, code: code, remember: remember })
        });
        const result = await response.json();

        if (result.success) {
            if (result.newDeviceToken) {
                localStorage.setItem('pp_device_token', result.newDeviceToken);
            }
            // ✅ NEW: Sync RLS session after 2FA verification
            await syncRLSSession(result.user?.userid);
            authorizeUser(result.user);
        } else {
            Swal.fire('Error', result.message || 'Invalid code.', 'error');
        }
    } catch (err) { Swal.fire('Error', 'Verification failed.', 'error'); }
}

async function handleLogout() {
    Swal.fire({
        title: 'Logout?',
        text: "You will need to re-authenticate to access the portal.",
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'Yes, Logout',
        confirmButtonColor: '#d33',
        cancelButtonColor: '#3085d6'
    }).then((result) => {
        if (result.isConfirmed) {
            const deviceToken = localStorage.getItem('pp_device_token');
            
            localStorage.clear();
            sessionStorage.clear();
            
            if(deviceToken) localStorage.setItem('pp_device_token', deviceToken);

            const jarvisBtn = document.getElementById('jarvis-trigger');
            const jarvisSidebar = document.getElementById('jarvis-sidebar');
            
            if (jarvisBtn) jarvisBtn.style.display = 'none';
            if (jarvisSidebar) {
                jarvisSidebar.classList.remove('active');
                jarvisSidebar.style.display = 'none';
            }

            window.location.href = 'index.html';
        }
    });
}

function toggleJarvis() {
    const sidebar = document.getElementById('jarvis-sidebar');
    if (sidebar) sidebar.classList.toggle('active');
}

async function teachJarvis(userQuestion, wrongAnswer) {
    const { value: correction } = await Swal.fire({
        title: 'Correct Jarvis',
        text: `You asked: "${userQuestion}"`,
        input: 'textarea',
        inputLabel: 'What is the correct factual information?',
        inputPlaceholder: 'e.g. The correct Merchant ID for Kenosha Raceway is K-9988...',
        showCancelButton: true,
        confirmButtonColor: '#38bdf8'
    });

    if (correction) {
        Swal.fire({ title: 'Ingesting Knowledge...', didOpen: () => Swal.showLoading() });
        try {
            await fetch('/api/train-jarvis', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    topic: userQuestion, 
                    logic: correction,
                    category: 'correction',
                    userId: localStorage.getItem('pp_userid')
                })
            });
            Swal.fire('Learned!', 'Jarvis has updated his core logic for this topic.', 'success');
        } catch (e) {
            Swal.fire('Error', 'Failed to update brain.', 'error');
        }
    }
}

async function askJarvis() {
    const input = document.getElementById('jarvis-input');
    const container = document.getElementById('jarvis-messages');
    const query = input.value.trim();
    if (!query) return;

    container.innerHTML += `<div class="user-bubble">${query}</div>`;
    input.value = '';
    container.scrollTop = container.scrollHeight;

    const loadingId = 'jarvis-' + Date.now();
    container.innerHTML += `<div class="ai-bubble" id="${loadingId}">Thinking...</div>`;
    container.scrollTop = container.scrollHeight;

    try {
        const res = await fetch('/api/oracle-agent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                query,
                userId: localStorage.getItem('pp_userid'),
                userName: localStorage.getItem('pp_user_first_name')
            })
        });
        const data = await res.json();
        const loadingEl = document.getElementById(loadingId);
        loadingEl.innerHTML = `<div>${data.answer}</div>`;
    } catch (err) {
        document.getElementById(loadingId).innerText = "Jarvis is offline. Check API connectivity.";
    }
    container.scrollTop = container.scrollHeight;
}

async function handleForgotPassword() {
    const { value: email } = await Swal.fire({
        title: 'Reset Password',
        input: 'email',
        inputLabel: 'Enter your staff email address',
        inputPlaceholder: 'name@payprotec.com',
        showCancelButton: true,
        confirmButtonColor: '#004990'
    });

    if (email) {
        Swal.fire({ title: 'Processing...', didOpen: () => Swal.showLoading() });
        try {
            await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: email, action: 'forgotPassword' })
            });
            Swal.fire('Check your Email', 'A reset link has been sent if the account exists.', 'success');
        } catch (err) { Swal.fire('Error', 'Connection failed.', 'error'); }
    }
}

window.onload = initGatekeeper;

document.addEventListener('keypress', function (e) {
    if (e.key === 'Enter') {
        const loginUI = document.getElementById('login-ui');
        if (loginUI && loginUI.style.display !== 'none') handleManualLogin();
    }
});
