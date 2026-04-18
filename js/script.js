/**
 * SECURITY NOTE: Supabase keys have been removed from the frontend.
 * All database communication now happens via the /api/login endpoint.
 */

const parseBool = (val) => {
    if (val === true || val === "true" || val === "TRUE") return true;
    return false;
};
document.getElementById('initial-loader').style.display = 'none';

async function checkGlobalNotifications() {
    // Priority: Session storage first, then Local for chat persistence
    const uid = sessionStorage.getItem('pp_userid') || localStorage.getItem('userid');
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
                if (totalUnread > 0) {
                    badge.innerText = totalUnread > 99 ? '99+' : totalUnread;
                    badge.style.display = 'block';
                } else {
                    badge.style.display = 'none';
                }
            }
        }
    } catch (err) {
        console.error("Notification check failed:", err);
    }
}

// Check immediately on load and every 10 seconds
checkGlobalNotifications();
setInterval(checkGlobalNotifications, 10000);

async function initGatekeeper() {
    const params = new URLSearchParams(window.location.search);
    const urlUserId = params.get('userid');
    const cachedUserId = sessionStorage.getItem('pp_userid');
    
    // --- SESSION COLLISION GUARD ---
    // If a different user tries to enter via URL while a session is active, force a wipe
    if (urlUserId && cachedUserId && urlUserId !== cachedUserId) {
        sessionStorage.clear();
        localStorage.removeItem('userid');
        location.reload();
        return;
    }

    // 1. Initial Access Check
    if (!urlUserId && !cachedUserId) {
        document.getElementById('login-ui').style.display = 'block';
        return;
    }

    const userId = urlUserId || cachedUserId;

    // 2. Validate session via the Secure API
    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: userId, action: 'validate' })
        });

        const result = await response.json();

        if (!result.success || !result.user) {
            document.getElementById('access-denied').style.display = 'block';
            document.getElementById('denied-reason').innerText = "User not enrolled in registry.";
            return;
        }

        // Now that we use real passwords, we skip the old "External Passkey" prompt
        authorizeUser(result.user);

    } catch (err) {
        console.error("Gatekeeper error:", err);
        Swal.fire('System Error', 'Could not connect to security server.', 'error');
    }
}

async function handleManualLogin() {
    const email = document.getElementById('login-email').value;
    const pass = document.getElementById('login-pass').value;

    if (!email || !pass) {
        Swal.fire('Required', 'Please enter both email and password.', 'warning');
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
            authorizeUser(result.user);
        } else {
            Swal.fire('Login Failed', result.message || 'Invalid credentials.', 'error');
        }
    } catch (error) {
        console.error("Login error:", error);
        Swal.fire('Error', 'Connection to security server failed.', 'error');
    }
}

function authorizeUser(user) {
    const isIframe = (window.self !== window.top);
    const role = (user.role || "").toLowerCase();
    
    // 1. Secure Session Storage (Single Source of Truth)
    sessionStorage.setItem('pp_userid', user.userid);
    sessionStorage.setItem('pp_role', user.role);
    sessionStorage.setItem('pp_verified', 'true');

    // 2. Chat System Integration (Persistent ID)
    localStorage.setItem('userid', user.userid);

    // 3. UI Reset
    if (!isIframe) {
        document.getElementById('logout-btn').style.display = 'inline-block';
    }
    document.getElementById('login-ui').style.display = 'none';
    document.getElementById('page-curtain').style.display = 'block';
    document.getElementById('user-greeting').innerText = `WELCOME, ${user.first_name.toUpperCase()}`;

    // 4. ADMIN & SUPER_ADMIN ONLY: Show Management Cards
    const isAdmin = role.includes('admin') || role.includes('super');
    if (isAdmin) {
        document.getElementById('card-cms').style.display = 'flex';
        document.getElementById('card-logs').style.display = 'flex';
    } else {
        document.getElementById('card-cms').style.display = 'none';
        document.getElementById('card-logs').style.display = 'none';
    }

    // 5. Standard Permission Checks
    if (!parseBool(user.access_inventory)) document.getElementById('card-inventory').style.display = 'none';
    if (!parseBool(user.access_deployments)) document.getElementById('card-deployments').style.display = 'none';
    if (!parseBool(user.access_returns)) document.getElementById('card-returns').style.display = 'none';
    if (!parseBool(user.access_merchants)) document.getElementById('card-merchants').style.display = 'none';
    
    Swal.close();
}

async function handleLogout() {
    const uid = sessionStorage.getItem('pp_userid') || localStorage.getItem('userid');

    Swal.fire({
        title: 'Logout?',
        text: "You will need to re-authenticate to access the portal.",
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'Yes, Logout',
        confirmButtonColor: '#d33'
    }).then(async (result) => {
        if (result.isConfirmed) {
            // Chat Online Status Fix
            if (uid) {
                try {
                    await fetch('/api/chat', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ action: 'logout', sender_id: uid })
                    });
                } catch (err) {
                    console.error("Failed to notify server of logout", err);
                }
            }

            // Total Wipe for Security
            sessionStorage.clear();
            localStorage.clear();
            location.href = 'index.html';
        }
    });
}

window.onload = initGatekeeper;
