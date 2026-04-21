/**
 * PAYPROTEC GATEKEEPER 
 * Robust version to prevent loader hangs.
 */

const parseBool = (val) => (val === true || val === "true" || val === "TRUE");

// This function MUST run to hide the loader
async function initGatekeeper() {
    try {
        const params = new URLSearchParams(window.location.search);
        const urlUserId = params.get('userid');
        
        // Safety check for Incognito/Private mode
        let cachedUserId = null;
        try {
            cachedUserId = localStorage.getItem('pp_userid');
        } catch (e) {
            console.warn("Storage access denied");
        }

        // 1. If we have a URL ID and it's different, wipe and reload
        if (urlUserId && cachedUserId && urlUserId !== cachedUserId) {
            localStorage.clear();
            window.location.href = window.location.pathname + '?userid=' + urlUserId;
            return;
        }

        const userId = urlUserId || cachedUserId;

        // 2. No ID? Show Login and STOP.
        if (!userId) {
            showLoginUI();
            return;
        }

        // 3. Validate Session
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
        showLoginUI(); // Always fall back to login UI on error
    }
}
/**
 * GLOBAL NOTIFICATION LISTENER
 * Updates the 'Direct Messages' badge when new messages arrive.
 */
async function checkGlobalNotifications() {
    const uid = localStorage.getItem('pp_userid');
    const badge = document.getElementById('nav-msg-badge');
    
    if (!uid || !badge) return;

    // 1. Initial count of unread messages for this user
    const { count, error } = await supabase
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .eq('recipient_id', uid)
        .eq('is_read', false);

    if (!error && count > 0) {
        badge.innerText = count > 99 ? '99+' : count;
        badge.style.display = 'block';
    }

    // 2. Real-time listener for incoming messages
    supabase
        .channel('global-notifications')
        .on('postgres_changes', { 
            event: 'INSERT', 
            schema: 'public', 
            table: 'messages',
            filter: `recipient_id=eq.${uid}` 
        }, (payload) => {
            // Increment badge count
            const currentCount = parseInt(badge.innerText) || 0;
            badge.innerText = currentCount + 1;
            badge.style.display = 'block';
            
            // Optional: Play a subtle notification sound
            // new Audio('assets/notify.mp3').play();
        })
        .subscribe();
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
        // 1. CLEAR & SET SESSION
        // Clear old junk first to ensure no role-bleeding
        localStorage.clear();

        localStorage.setItem('pp_userid', user.userid || '');
        localStorage.setItem('pp_role', user.role || 'Regular User'); 
        localStorage.setItem('pp_verified', 'true');
        localStorage.setItem('userid', user.userid || ''); // Legacy Chat Support

        // --- CRITICAL: IO WAIT ---
        // Forces a tiny pause so the browser actually commits these strings to disk
        await new Promise(r => setTimeout(r, 100));

    } catch (e) { 
        console.error("Storage Error:", e); 
    }

    // 2. UI VISIBILITY
    const elements = {
        loader: document.getElementById('initial-loader'),
        loginUI: document.getElementById('login-ui'),
        curtain: document.getElementById('page-curtain'),
        greeting: document.getElementById('user-greeting'),
        logoutBtn: document.getElementById('logout-btn')
    };

    if (elements.loader) elements.loader.style.display = 'none';
    if (elements.loginUI) elements.loginUI.style.display = 'none';
    if (elements.curtain) elements.curtain.style.display = 'block';
    
    if (user.first_name && elements.greeting) {
        elements.greeting.innerText = `WELCOME, ${user.first_name.toUpperCase()}`;
    }
    
    if (elements.logoutBtn) elements.logoutBtn.style.display = 'inline-block';

    // 3. ROLE-BASED ACCESS
    // Normalize: lowercase and remove spaces/underscores
    const roleStr = (user.role || "").toLowerCase().replace(/[\s_]/g, '');
    
    // Super Admin & Operations Admin both contain "admin" or "super"
    const isAdmin = roleStr.includes('admin') || roleStr.includes('super');
    
    const cmsCard = document.getElementById('card-cms');
    const logsCard = document.getElementById('card-logs');
    if (cmsCard) cmsCard.style.display = isAdmin ? 'flex' : 'none';
    if (logsCard) logsCard.style.display = isAdmin ? 'flex' : 'none';

    // 4. FEATURE PERMISSIONS
    const permMap = {
        'card-inventory': user.access_inventory,
        'card-deployments': user.access_deployments,
        'card-returns': user.access_returns,
        'card-merchants': user.access_merchants
    };

    Object.keys(permMap).forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            // Using your parseBool helper
            el.style.display = parseBool(permMap[id]) ? 'flex' : 'none';
        }
    });
    
    if (window.Swal) Swal.close();
    if (typeof checkGlobalNotifications === 'function') checkGlobalNotifications();
}

async function handleManualLogin() {
    const email = document.getElementById('login-email').value;
    const pass = document.getElementById('login-pass').value;
    
    // Retrieve the token
    const currentToken = localStorage.getItem('pp_device_token'); 
    
    // DEBUG: Look at your console (F12) when you click login. 
    // If this says 'null', your browser didn't save it.
    console.log("Device Token found in browser:", currentToken);

    if (!email || !pass) return;

    Swal.fire({ title: 'Authenticating...', didOpen: () => Swal.showLoading() });

    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                action: 'login',
                email: email, 
                passkey: pass, 
                deviceToken: currentToken // MUST match the variable name in login.js
            })
        });
        const result = await response.json();

        if (result.success) {
            // NEW: Check if the server requires 2FA
            if (result.needs2FA) {
                Swal.close(); // Close "Authenticating..." spinner
                
                const { value: tfaCode } = await Swal.fire({
                    title: 'New Device Detected',
                    text: 'Please enter the 6-digit code sent to your email.',
                    input: 'text',
                    inputAttributes: { maxlength: 6, autofocus: 'true' },
                    footer: '<label style="cursor:pointer;"><input type="checkbox" id="remember-device"> Remember this device for 30 days</label>',
                    showCancelButton: true,
                    confirmButtonText: 'Verify Code',
                    confirmButtonColor: '#004990'
                });

                if (tfaCode) {
                    const remember = document.getElementById('remember-device').checked;
                    verify2FACode(result.userid, tfaCode, remember);
                }
            } else {
                // If device was already trusted, log in immediately
                authorizeUser(result.user);
            }
        } else {
            Swal.fire('Login Failed', result.message || 'Invalid credentials.', 'error');
        }
    } catch (error) {
        console.error("Login Error:", error);
        Swal.fire('Error', 'Connection failed.', 'error');
    }
}
// js/script.js

async function verify2FACode(uid, code, remember) {
    Swal.fire({ title: 'Verifying...', didOpen: () => Swal.showLoading() });

    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                action: 'verify2FA', 
                userId: uid, 
                code: code, 
                remember: remember 
            })
        });
        const result = await response.json();

        if (result.success) {
            // CRITICAL: Save the token before authorizing
            if (result.newDeviceToken) {
                console.log("Saving new device token:", result.newDeviceToken);
                localStorage.setItem('pp_device_token', result.newDeviceToken);
            }
            
            // Authorization follows
            authorizeUser(result.user);
        } else {
            Swal.fire('Error', result.message || 'Invalid code.', 'error');
        }
    } catch (err) {
        Swal.fire('Error', 'Verification failed.', 'error');
    }
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
    }).then(async (result) => {
        if (result.isConfirmed) {
            localStorage.clear();
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
            const result = await response.json();
            Swal.fire('Check your Email', 'A reset link has been sent if the account exists.', 'success');
        } catch (err) {
            Swal.fire('Error', 'Connection failed.', 'error');
        }
    }
}

window.onload = initGatekeeper;

// [ADD TO BOTTOM OF script.js]
document.addEventListener('keypress', function (e) {
    if (e.key === 'Enter') {
        const loginUI = document.getElementById('login-ui');
        if (loginUI && loginUI.style.display !== 'none') {
            handleManualLogin();
        }
    }
});
