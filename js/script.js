const SUPABASE_URL = "https://zuzwljjrppyrzngmhdru.supabase.co";
const SUPABASE_KEY = "sb_publishable_DgzVF5uoTSV1A_c0V7jvpQ_v96Ov0bO";
const _supabase = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const parseBool = (val) => {
    if (val === true || val === "true" || val === "TRUE") return true;
    return false;
};

async function initGatekeeper() {
    const params = new URLSearchParams(window.location.search);
    const urlUserId = params.get('userid');
    const cachedUserId = sessionStorage.getItem('pp_userid');
    const isIframe = (window.self !== window.top);

    if (!urlUserId && !cachedUserId) {
        document.getElementById('login-ui').style.display = 'block';
        return;
    }

    if (urlUserId && urlUserId !== cachedUserId) {
        sessionStorage.clear();
    }

    const userId = urlUserId || cachedUserId;

    const { data: user, error } = await _supabase
        .from('app_users')
        .select('*')
        .eq('userid', userId)
        .single();

    if (error || !user) {
        document.getElementById('access-denied').style.display = 'block';
        document.getElementById('denied-reason').innerText = "User not enrolled in registry.";
        return;
    }

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
}

async function handleManualLogin() {
    const email = document.getElementById('login-email').value;
    const pass = document.getElementById('login-pass').value;

    if (!email || !pass) {
        Swal.fire('Required', 'Please enter both email and passkey.', 'warning');
        return;
    }

    Swal.fire({ title: 'Authenticating...', didOpen: () => Swal.showLoading() });

    const { data: user, error } = await _supabase
        .from('app_users')
        .select('*')
        .eq('email', email)
        .eq('passkey', pass)
        .single();

    if (error || !user) {
        Swal.fire('Login Failed', 'Invalid email address or passkey.', 'error');
        return;
    }

    sessionStorage.setItem('pp_verified', 'true');
    authorizeUser(user);
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