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
        secretDungeon: document.getElementById('card-secret') // Add this line
    };

    if (elements.loader) elements.loader.style.display = 'none';
    if (elements.loginUI) elements.loginUI.style.display = 'none';
    if (elements.curtain) elements.curtain.style.display = 'block';
    if (user.first_name && elements.greeting) elements.greeting.innerText = `WELCOME, ${user.first_name.toUpperCase()}`;
    // THE REVEAL
if (userData.role === 'super_admin' && elements.secretDungeon) {
    elements.secretDungeon.classList.remove('slds-hide');
    console.log("🔓 Secret Dungeon access authorized for " + userData.email);
}
    if (elements.logoutBtn) elements.logoutBtn.style.display = 'inline-block';

    const roleStr = (user.role || "").toLowerCase().replace(/[\s_]/g, '');
    const isAdmin = roleStr.includes('admin') || roleStr.includes('super');
    
    if (document.getElementById('card-cms')) document.getElementById('card-cms').style.display = isAdmin ? 'flex' : 'none';
    if (document.getElementById('card-logs')) document.getElementById('card-logs').style.display = isAdmin ? 'flex' : 'none';

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
            const deviceToken = localStorage.getItem('pp_device_token');
            localStorage.clear();
            if(deviceToken) localStorage.setItem('pp_device_token', deviceToken);
            sessionStorage.clear();
            window.location.href = 'index.html';
        }
    });
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
// This should run after your user session is verified
function authorizeSecretDungeon() {
    const role = localStorage.getItem('pp_role'); // Ensure your login saves the role here
    const secretCard = document.getElementById('card-secret');
    
    if (role === 'super_admin' && secretCard) {
        secretCard.classList.remove('slds-hide');
        console.log("🔐 Secret Dungeon Access Granted.");
    }
}
function openSecretDungeon() {
    Swal.fire({
        title: '<span style="color:#4338ca; font-weight:800;">SECRET DUNGEON</span>',
        html: `
            <div style="text-align: left; font-size: 13px; color: #475569;">
                <p style="margin-bottom: 15px;">Welcome, High Commander. Choose your administrative exploit:</p>
                
                <div style="background: white; border: 1px solid #e2e8f0; border-radius: 12px; padding: 15px;">
                    <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 10px;">
                        <span class="material-icons" style="color: #6366f1;">description</span>
                        <strong style="color: #1e293b;">Merchant Note Injector</strong>
                    </div>
                    <p style="font-size: 11px; margin-bottom: 10px;">Upload a CSV with <b>merchant_id</b>, <b>title</b>, and <b>body</b>. Notes will be linked via UUID automatically.</p>
                    <button onclick="triggerBulkNoteUpload()" class="slds-button slds-button_brand" style="width: 100%; background: #6366f1;">
                        UPLOAD CSV & INJECT
                    </button>
                </div>

                <div style="margin-top: 15px; opacity: 0.5; text-align: center; font-family: monospace; font-size: 10px;">
                    SESSION_ID: ${localStorage.getItem('pp_userid') || 'ANONYMOUS'}
                </div>
            </div>
        `,
        showConfirmButton: false,
        showCancelButton: true,
        cancelButtonText: 'CLOSE PORTAL',
        background: '#f8fafc',
        width: '500px'
    });
}
function triggerBulkNoteUpload() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv';
    
    input.onchange = async (e) => {
        const file = e.target.files[0];
        // 1. You will need a library like PapaParse or a custom CSV parser here
        // 2. Loop through the rows and call your /api/bulk-notes endpoint
        Swal.fire('Processing', `Injecting notes from ${file.name}...`, 'info');
    };
    
    input.click();
}
function checkDungeonAccess() {
    // 1. Get the role (Make sure your login process actually sets this!)
    const role = localStorage.getItem('pp_role'); 
    const secretCard = document.getElementById('card-secret');
    
    console.log("Current User Role:", role); // Check your console (F12) to see what this says

    if (role === 'super_admin' && secretCard) {
        secretCard.classList.remove('slds-hide');
        console.log("Secret Dungeon initialized.");
    }
}

// 2. Ensure this runs AFTER the loader is gone
// Find where your code hides 'initial-loader' and shows 'page-curtain'
// Add checkDungeonAccess() right after that line.

