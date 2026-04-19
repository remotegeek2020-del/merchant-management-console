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
