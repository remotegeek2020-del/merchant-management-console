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

async function initGatekeeper() {
    const params = new URLSearchParams(window.location.search);
    const urlUserId = params.get('userid');
    const cachedUserId = sessionStorage.getItem('pp_userid');

    // --- ENFORCEMENT: Only 1 User per Browser Instance ---
    // If someone tries to switch users via URL while a session is active
    if (urlUserId && cachedUserId && urlUserId !== cachedUserId) {
        console.warn("New user detected. Wiping previous session for security.");
        sessionStorage.clear();
        localStorage.clear(); // Clear chat IDs too
        location.reload(); 
        return;
    }

    // 1. If we are already logged in and no new ID is forced, just show dashboard
    if (!urlUserId && cachedUserId) {
        // We still validate the session to ensure the user wasn't deleted
        validateAndAuthorize(cachedUserId);
        return;
    }

    // 2. If no ID anywhere, show Login UI
    if (!urlUserId && !cachedUserId) {
        document.getElementById('login-ui').style.display = 'block';
        return;
    }

    // 3. If we have a URL ID, validate it
    validateAndAuthorize(urlUserId);
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
    // 1. Set Session Storage (Active Tab only)
    sessionStorage.setItem('pp_userid', user.userid);
    sessionStorage.setItem('pp_role', user.role);
    sessionStorage.setItem('pp_verified', 'true');

    // 2. Set Local Storage ONLY for the Chat/Direct Message integration
    localStorage.setItem('userid', user.userid);

    // 3. UI Toggle
    document.getElementById('login-ui').style.display = 'none';
    document.getElementById('page-curtain').style.display = 'block';
    document.getElementById('user-greeting').innerText = `WELCOME, ${user.first_name.toUpperCase()}`;
    document.getElementById('logout-btn').style.display = 'inline-block';

    // 4. Permission Logic
    const role = (user.role || "").toLowerCase();
    const isAdmin = role.includes('admin') || role.includes('super');
    
    document.getElementById('card-cms').style.display = isAdmin ? 'flex' : 'none';
    document.getElementById('card-logs').style.display = isAdmin ? 'flex' : 'none';

    if (!parseBool(user.access_inventory)) document.getElementById('card-inventory').style.display = 'none';
    if (!parseBool(user.access_deployments)) document.getElementById('card-deployments').style.display = 'none';
    if (!parseBool(user.access_returns)) document.getElementById('card-returns').style.display = 'none';
    if (!parseBool(user.access_merchants)) document.getElementById('card-merchants').style.display = 'none';
    
    Swal.close();
    checkGlobalNotifications();
}

async function handleLogout() {
    const uid = sessionStorage.getItem('pp_userid');

    Swal.fire({
        title: 'Logout?',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'Yes, Logout',
        confirmButtonColor: '#d33'
    }).then(async (result) => {
        if (result.isConfirmed) {
            if (uid) {
                await fetch('/api/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'logout', sender_id: uid })
                });
            }
            sessionStorage.clear();
            localStorage.clear();
            location.href = 'index.html';
        }
    });
}

window.onload = initGatekeeper;
