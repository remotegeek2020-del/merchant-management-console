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

function showLoginUI() {
    const loader = document.getElementById('initial-loader');
    const loginUI = document.getElementById('login-ui');
    if (loader) loader.style.display = 'none';
    if (loginUI) loginUI.style.display = 'block';
}

function authorizeUser(user) {
    try {
        localStorage.setItem('pp_userid', user.userid || '');
        localStorage.setItem('pp_role', user.role || 'user'); 
        localStorage.setItem('pp_verified', 'true');
        localStorage.setItem('userid', user.userid || '');
    } catch (e) { console.error("Could not save to storage"); }

    const loader = document.getElementById('initial-loader');
    const loginUI = document.getElementById('login-ui');
    const curtain = document.getElementById('page-curtain');
    
    if (loader) loader.style.display = 'none';
    if (loginUI) loginUI.style.display = 'none';
    if (curtain) curtain.style.display = 'block';
    
    if (user.first_name) {
        document.getElementById('user-greeting').innerText = `WELCOME, ${user.first_name.toUpperCase()}`;
    }
    
    document.getElementById('logout-btn').style.display = 'inline-block';

    // Permissions
    const role = (user.role || "").toLowerCase();
    const isAdmin = role.includes('admin') || role.includes('super');
    
    document.getElementById('card-cms').style.display = isAdmin ? 'flex' : 'none';
    document.getElementById('card-logs').style.display = isAdmin ? 'flex' : 'none';

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
}

async function handleManualLogin() {
    const email = document.getElementById('login-email').value;
    const pass = document.getElementById('login-pass').value;

    if (!email || !pass) return;

    Swal.fire({ title: 'Authenticating...', didOpen: () => Swal.showLoading() });

    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email, passkey: pass, action: 'login' })
        });
        const result = await response.json();

        if (result.success) {
            authorizeUser(result.user);
        } else {
            Swal.fire('Login Failed', result.message || 'Invalid credentials.', 'error');
        }
    } catch (error) {
        Swal.fire('Error', 'Connection failed.', 'error');
    }
}

async function handleLogout() {
    localStorage.clear();
    window.location.href = 'index.html';
}

window.onload = initGatekeeper;
