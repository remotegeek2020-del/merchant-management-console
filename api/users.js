/**
 * PAYPROTEC GATEKEEPER - FINAL COMPILED LOGIC
 * Handles: Login, Multi-tab Session, and Anti-Collision
 */

const parseBool = (val) => (val === true || val === "true" || val === "TRUE");

async function initGatekeeper() {
    const params = new URLSearchParams(window.location.search);
    const urlUserId = params.get('userid');
    const cachedUserId = localStorage.getItem('pp_userid');

    // 1. If we just arrived from a link with a NEW ID, wipe the old one
    if (urlUserId && cachedUserId && urlUserId !== cachedUserId) {
        localStorage.clear();
        location.href = window.location.pathname + '?userid=' + urlUserId;
        return;
    }

    // 2. Determine who we are checking
    const userId = urlUserId || cachedUserId;

    // 3. If no ID is found, show the login screen
    if (!userId) {
        document.getElementById('login-ui').style.display = 'block';
        return;
    }

    // 4. Validate existing session with the server
    try {
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
            document.getElementById('login-ui').style.display = 'block';
        }
    } catch (err) {
        console.error("Session validation failed:", err);
        document.getElementById('login-ui').style.display = 'block';
    }
}

async function handleManualLogin() {
    const email = document.getElementById('login-email').value;
    const pass = document.getElementById('login-pass').value;

    if (!email || !pass) {
        Swal.fire('Required', 'Enter email and password.', 'warning');
        return;
    }

    Swal.fire({ title: 'Authenticating...', didOpen: () => Swal.showLoading() });

    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email, passkey: pass, action: 'login' })
        });
        const result = await response.json();

        if (result.success) {
            // SUCCESS: Wipe old junk before setting new user
            localStorage.clear();
            authorizeUser(result.user);
        } else {
            Swal.fire('Login Failed', result.message || 'Invalid credentials.', 'error');
        }
    } catch (error) {
        Swal.fire('Error', 'Security server connection failed.', 'error');
    }
}

function authorizeUser(user) {
    // 1. SAVE TO STORAGE
    localStorage.setItem('pp_userid', user.userid || '');
    localStorage.setItem('pp_role', user.role || 'user'); 
    localStorage.setItem('pp_verified', 'true');
    localStorage.setItem('userid', user.userid || ''); // Chat compatibility

    // 2. UI UPDATES
    const loginUI = document.getElementById('login-ui');
    const curtain = document.getElementById('page-curtain');
    
    if (loginUI) loginUI.style.display = 'none';
    if (curtain) curtain.style.display = 'block';
    
    const greeting = document.getElementById('user-greeting');
    if (greeting && user.first_name) {
        greeting.innerText = `WELCOME, ${user.first_name.toUpperCase()}`;
    }
    
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) logoutBtn.style.display = 'inline-block';

    // 3. ADMIN PERMISSIONS
    const roleString = (user.role || "").toLowerCase();
    const isAdmin = roleString.includes('admin') || roleString.includes('super');
    
    const cmsCard = document.getElementById('card-cms');
    const logsCard = document.getElementById('card-logs');
    if (cmsCard) cmsCard.style.display = isAdmin ? 'flex' : 'none';
    if (logsCard) logsCard.style.display = isAdmin ? 'flex' : 'none';

    // 4. APP PERMISSIONS
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

async function handleLogout() {
    const uid = localStorage.getItem('pp_userid');
    if (uid) {
        await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'logout', sender_id: uid })
        });
    }
    localStorage.clear();
    location.href = 'index.html';
}

window.onload = initGatekeeper;
