/**
 * PAYPROTEC GATEKEEPER 
 */
const parseBool = (val) => (val === true || val === "true" || val === "TRUE");

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
    const userEmail = localStorage.getItem('pp_userid'); // Standardized key from your script.js
    try {
        await fetch('/api/logs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: userEmail || 'System',
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
        localStorage.setItem('userid', user.userid || ''); 
        await new Promise(r => setTimeout(r, 100));
    } catch (e) { console.error("Storage Error:", e); }

    const elements = {
        loader: document.getElementById('initial-loader'),
        loginUI: document.getElementById('login-ui'),
        curtain: document.getElementById('page-curtain'),
        greeting: document.getElementById('user-greeting'),
        logoutBtn: document.getElementById('logout-btn'),
        secretDungeon: document.getElementById('card-secret') // Added
        jarvisBtn: document.getElementById('jarvis-trigger'),
    jarvisSidebar: document.getElementById('jarvis-sidebar')
    };
// Check if the elements exist and reveal them
if (elements.jarvisBtn && elements.jarvisSidebar) {
    elements.jarvisBtn.style.display = 'block'; 
    elements.jarvisSidebar.style.display = 'flex';
    console.log("🤖 Jarvis Online.");
}

   // Use Optional Chaining or IF checks to prevent crashes
    if (elements.loader) elements.loader.style.display = 'none';
    if (elements.loginUI) elements.loginUI.style.display = 'none';
    if (elements.curtain) elements.curtain.style.display = 'block';
    if (user.first_name && elements.greeting) elements.greeting.innerText = `WELCOME, ${user.first_name.toUpperCase()}`;
    if (elements.logoutBtn) elements.logoutBtn.style.display = 'inline-block';
    // --- JARVIS ACTIVATION ---
    // Only show Jarvis for authenticated users
    if (elements.jarvisBtn && elements.jarvisSidebar) {
        elements.jarvisBtn.style.display = 'block';
        elements.jarvisSidebar.style.display = 'flex'; 
    }
    
    // Role Logic
    const roleStr = (user.role || "").toLowerCase().replace(/[\s_]/g, '');
    const isSuperAdmin = roleStr.includes('super');
    const isAdmin = roleStr.includes('admin') || isSuperAdmin;
    
    
    // Manage Admin Cards
    if (document.getElementById('card-cms')) document.getElementById('card-cms').style.display = isAdmin ? 'flex' : 'none';
    if (document.getElementById('card-logs')) document.getElementById('card-logs').style.display = isAdmin ? 'flex' : 'none';
// THE REVEAL: Only try to show the dungeon if the card actually exists
    if (isSuperAdmin && elements.secretDungeon) {
        elements.secretDungeon.classList.remove('slds-hide');
        elements.secretDungeon.style.display = 'flex';
        console.log("🔓 Secret Dungeon access authorized.");
    }
    const permMap = {
        'card-inventory': user.access_inventory,
        'card-deployments': user.access_deployments,
        'card-returns': user.access_returns,
        'card-merchants': user.access_merchants
    };

    Object.keys(permMap).forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = parseBool(permMap[id]) ? 'flex' : 'none';
    });
    
    if (window.Swal) Swal.close();
    if (typeof checkGlobalNotifications === 'function') checkGlobalNotifications();
}
function openSecretDungeon() {
    Swal.fire({
        title: '<span style="color:#4338ca; font-weight:800;">SECRET DUNGEON</span>',
        html: `
            <div style="text-align: left; font-size: 13px;">
                <p style="margin-bottom: 15px; color: #475569;">Administrator Override Console Active.</p>
                <div style="background: white; border: 1px solid #e2e8f0; border-radius: 12px; padding: 15px;">
                    <strong style="color: #1e293b; display: block; margin-bottom: 5px;">Bulk Merchant Note Injector</strong>
                    <p style="font-size: 11px; margin-bottom: 10px; color: #64748b;">Upload a CSV with: merchant_id, title, body</p>
                    <button onclick="triggerBulkNoteUpload()" class="slds-button slds-button_brand" style="width: 100%; background: #6366f1;">
                        UPLOAD CSV
                    </button>
                </div>
            </div>
        `,
        showConfirmButton: false,
        showCancelButton: true,
        cancelButtonText: 'CLOSE PORTAL'
    });
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
            // Simple split for Merchant ID (col 0), Title (col 1), Body (col 2)
            const rows = text.split('\n').slice(1).filter(r => r.trim()); 
            const notes = rows.map(r => {
                const cols = r.split(',');
                return { merchant_id: cols[0]?.trim(), title: cols[1]?.trim(), body: cols[2]?.trim() };
            });

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
                    }, // Added missing comma here
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
            // 1. Save device token if needed
            const deviceToken = localStorage.getItem('pp_device_token');
            
            // 2. Clear all session data
            localStorage.clear();
            sessionStorage.clear();
            
            if(deviceToken) localStorage.setItem('pp_device_token', deviceToken);

            // --- 3. JARVIS CLEANUP (Place it here) ---
            const jarvisBtn = document.getElementById('jarvis-trigger');
            const jarvisSidebar = document.getElementById('jarvis-sidebar');
            
            if (jarvisBtn) jarvisBtn.style.display = 'none'; // Hide the button
            if (jarvisSidebar) {
                jarvisSidebar.classList.remove('active'); // Slide it out if open
                jarvisSidebar.style.display = 'none';    // Kill the container
            }
            // -----------------------------------------

            // 4. Return to login
            window.location.href = 'index.html';
        }
    });
}
function toggleJarvis() {
    document.getElementById('jarvis-sidebar').classList.toggle('active');
}

async function askJarvis() {
    const input = document.getElementById('jarvis-input');
    const container = document.getElementById('jarvis-messages');
    const query = input.value.trim();
    if (!query) return;

    container.innerHTML += `<div class="user-bubble" style="background: #334155;">${query}</div>`;
    input.value = '';
    container.scrollTop = container.scrollHeight;

    const loadingId = 'jarvis-' + Date.now();
    container.innerHTML += `<div class="ai-bubble" id="${loadingId}">Consulting database...</div>`;

    try {
        const res = await fetch('/api/oracle-agent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                query,
                userId: localStorage.getItem('pp_userid'),
                userName: localStorage.getItem('pp_user_first_name') // Ensure this is stored on login
            })
        });
        const data = await res.json();
        document.getElementById(loadingId).innerText = data.answer;
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
            const response = await fetch('/api/login', {
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
