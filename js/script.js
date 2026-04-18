/**
 * SECURITY: Single-User Session Enforcement
 * Purpose: Prevents account "bleeding" where two users are logged in simultaneously.
 */

const parseBool = (val) => (val === true || val === "true" || val === "TRUE");
document.getElementById('initial-loader').style.display = 'none';

async function checkGlobalNotifications() {
    // Only check if we have an active session
    const uid = sessionStorage.getItem('pp_userid');
    if (!uid) return;

    try {
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'getUserList', sender_id: uid })
        });
        const result = await response.json();
        if (result.success && result.unreadCounts) {
            const totalUnread = Object.values(result.unreadCounts).reduce((a, b) => a + b, 0);
            const badge = document.getElementById('nav-msg-badge');
            if (badge) {
                badge.innerText = totalUnread > 99 ? '99+' : totalUnread;
                badge.style.display = totalUnread > 0 ? 'block' : 'none';
            }
        }
    } catch (err) { console.error("Notification check failed:", err); }
}

// Check every 10 seconds
setInterval(checkGlobalNotifications, 10000);

/**
 * REFINED SESSION MANAGEMENT
 * Uses LocalStorage for multi-tab support with Server-Side Validation.
 */

async function initGatekeeper() {
    const params = new URLSearchParams(window.location.search);
    const urlUserId = params.get('userid');
    
    // Switch to localStorage so sessions persist across tabs
    const cachedUserId = localStorage.getItem('pp_userid');

    // 1. SESSION COLLISION GUARD
    // If a different user tries to enter via URL while another is logged in
    if (urlUserId && cachedUserId && urlUserId !== cachedUserId) {
        console.warn("New user identity detected. Switching sessions.");
        localStorage.clear();
        location.reload();
        return;
    }

    // 2. IDENTIFY TARGET USER
    const userId = urlUserId || cachedUserId;

    // 3. NO ID FOUND -> SHOW LOGIN
    if (!userId) {
        document.getElementById('login-ui').style.display = 'block';
        return;
    }

    // 4. VALIDATE SESSION WITH SERVER
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
            // If server says no, wipe everything and show login
            localStorage.clear();
            document.getElementById('login-ui').style.display = 'block';
        }
    } catch (err) {
        console.error("Gatekeeper validation failed:", err);
        document.getElementById('login-ui').style.display = 'block';
    }
}

async function validateAndAuthorize(userId) {
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
            // Failure: Wipe and show login
            sessionStorage.clear();
            document.getElementById('access-denied').style.display = 'block';
            document.getElementById('denied-reason').innerText = "Session expired or User not found.";
        }
    } catch (err) {
        console.error("Gatekeeper error:", err);
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
            // Before authorizing new user, wipe everything
            sessionStorage.clear();
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
    // 1. PERSIST SESSION (Now works across tabs)
    localStorage.setItem('pp_userid', user.userid);
    localStorage.setItem('pp_role', user.role);
    localStorage.setItem('userid', user.userid); // For Chat compatibility
    
    // Use a flag to bypass the passkey prompt if they are already authenticated
    localStorage.setItem('pp_verified', 'true');

    // 2. UI UPDATES
    document.getElementById('login-ui').style.display = 'none';
    document.getElementById('page-curtain').style.display = 'block';
    document.getElementById('user-greeting').innerText = `WELCOME, ${user.first_name.toUpperCase()}`;
    
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) logoutBtn.style.display = 'inline-block';

    // 3. PERMISSIONS
    const role = (user.role || "").toLowerCase();
    const isAdmin = role.includes('admin') || role.includes('super');
    
    // Manage visibility of admin cards
    const cmsCard = document.getElementById('card-cms');
    const logsCard = document.getElementById('card-logs');
    if (cmsCard) cmsCard.style.display = isAdmin ? 'flex' : 'none';
    if (logsCard) logsCard.style.display = isAdmin ? 'flex' : 'none';

    // Manage standard app permissions
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
    
    Swal.close();
    checkGlobalNotifications();
}

async function handleLogout() {
    const uid = localStorage.getItem('pp_userid');
    
    // Optional: Notify server
    if (uid) {
        fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'logout', sender_id: uid })
        });
    }

    // Wipe the entire browser cache for this site
    localStorage.clear();
    sessionStorage.clear();
    location.href = 'index.html';
}

window.onload = initGatekeeper;
