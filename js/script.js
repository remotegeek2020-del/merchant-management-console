/**
 * SECURITY NOTE: Supabase keys have been removed from the frontend.
 * All database communication now happens via the /api/login endpoint.
 */

const parseBool = (val) => {
    if (val === true || val === "true" || val === "TRUE") return true;
    return false;
};

async function initGatekeeper() {
    const params = new URLSearchParams(window.location.search);
    const urlUserId = params.get('userid');
    const cachedUserId = sessionStorage.getItem('pp_userid');
    const isIframe = (window.self !== window.top);

    // 1. Initial Access Check
    if (!urlUserId && !cachedUserId) {
        document.getElementById('login-ui').style.display = 'block';
        return;
    }

    if (urlUserId && urlUserId !== cachedUserId) {
        sessionStorage.clear();
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

        const user = result.user;

        // 3. Handle External Passkey Verification
        if (!isIframe && !sessionStorage.getItem('pp_verified')) {
            const { value: enteredPass } = await Swal.fire({
                title: `Verify Identity`,
                text: `Please enter your passkey to access outside HighLevel.`,
                input: 'password',
                confirmButtonText: 'Verify Identity',
                confirmButtonColor: '#004990',
                allowOutsideClick: false
            });

            if (enteredPass !== user.passkey) {
                Swal.fire('Access Denied', 'Invalid passkey code.', 'error').then(() => location.reload());
                return;
            }
            sessionStorage.setItem('pp_verified', 'true');
        }

        authorizeUser(user);

    } catch (err) {
        console.error("Gatekeeper error:", err);
        Swal.fire('System Error', 'Could not connect to security server.', 'error');
    }
}

async function handleManualLogin() {
    const email = document.getElementById('login-email').value;
    const pass = document.getElementById('login-pass').value;

    if (!email || !pass) {
        Swal.fire('Required', 'Please enter both email and passkey.', 'warning');
        return;
    }

    Swal.fire({ title: 'Authenticating...', didOpen: () => Swal.showLoading() });

    try {
        // We fetch our OWN Vercel API route now
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email, passkey: pass, action: 'login' })
        });

        const result = await response.json();

        if (result.success) {
            sessionStorage.setItem('pp_verified', 'true');
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
    
    sessionStorage.setItem('pp_userid', user.userid);
    sessionStorage.setItem('pp_role', user.role);

    if (!isIframe) {
        document.getElementById('logout-btn').style.display = 'inline-block';
    }

    document.getElementById('login-ui').style.display = 'none';
    document.getElementById('page-curtain').style.display = 'block';
    document.getElementById('user-greeting').innerText = `WELCOME, ${user.first_name.toUpperCase()}`;

    const role = (user.role || "").toLowerCase();

    if (role.includes('admin')) {
        document.getElementById('card-cms').style.display = 'flex';
    } 

    if (!parseBool(user.access_inventory)) document.getElementById('card-inventory').style.display = 'none';
    if (!parseBool(user.access_deployments)) document.getElementById('card-deployments').style.display = 'none';
    if (!parseBool(user.access_returns)) document.getElementById('card-returns').style.display = 'none';
    if (!parseBool(user.access_merchants)) document.getElementById('card-merchants').style.display = 'none';
    
    Swal.close();
}

function handleLogout() {
    Swal.fire({
        title: 'Logout?',
        text: "You will need to re-authenticate to access the portal.",
        icon: 'warning',
        showCancelButton: true,
        confirmButtonText: 'Yes, Logout',
        confirmButtonColor: '#d33'
    }).then((result) => {
        if (result.isConfirmed) {
            sessionStorage.clear();
            location.reload();
        }
    });
}

window.onload = initGatekeeper;
