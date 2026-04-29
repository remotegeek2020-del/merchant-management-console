async function authorizeUser(user) {
    if (!user) return;
    try {
        const deviceToken = localStorage.getItem('pp_device_token');
        localStorage.clear();
        if(deviceToken) localStorage.setItem('pp_device_token', deviceToken);

        localStorage.setItem('pp_userid', user.userid || '');
        localStorage.setItem('pp_role', user.role || 'Regular User'); 
        localStorage.setItem('pp_verified', 'true');
        localStorage.setItem('pp_user_first_name', user.first_name || 'Sir'); // Added for Jarvis persona
        localStorage.setItem('userid', user.userid || ''); 
        await new Promise(r => setTimeout(r, 100));
    } catch (e) { console.error("Storage Error:", e); }

    // Role Logic: Surgical Fix for underscores/spaces
    const roleStr = (user.role || "").toLowerCase().replace(/[\s_]/g, '');
    const isSuperAdmin = roleStr.includes('super');
    const isAdmin = roleStr.includes('admin') || isSuperAdmin;

    const elements = {
        loader: document.getElementById('initial-loader'),
        loginUI: document.getElementById('login-ui'),
        curtain: document.getElementById('page-curtain'),
        greeting: document.getElementById('user-greeting'),
        logoutBtn: document.getElementById('logout-btn'),
        secretDungeon: document.getElementById('card-secret'),
        jarvisBtn: document.getElementById('jarvis-trigger'),
        jarvisSidebar: document.getElementById('jarvis-sidebar')
    };

    if (elements.loader) elements.loader.style.display = 'none';
    if (elements.loginUI) elements.loginUI.style.display = 'none';
    if (elements.curtain) elements.curtain.style.display = 'block';
    if (user.first_name && elements.greeting) elements.greeting.innerText = `WELCOME, ${user.first_name.toUpperCase()}`;
    if (elements.logoutBtn) elements.logoutBtn.style.display = 'inline-block';

    // --- JARVIS ACTIVATION (Master Key Applied) ---
    const hasJarvisAccess = isSuperAdmin || parseBool(user.access_jarvis);
    if (hasJarvisAccess && elements.jarvisBtn && elements.jarvisSidebar) {
        elements.jarvisBtn.style.display = 'block';
        elements.jarvisSidebar.style.display = 'flex'; 
        console.log("🤖 Jarvis Online.");
    } else {
        if (elements.jarvisBtn) elements.jarvisBtn.style.display = 'none';
        if (elements.jarvisSidebar) elements.jarvisSidebar.style.display = 'none';
    }
    
    // Manage Admin Cards
    if (document.getElementById('card-cms')) document.getElementById('card-cms').style.display = isAdmin ? 'flex' : 'none';
    if (document.getElementById('card-logs')) document.getElementById('card-logs').style.display = isAdmin ? 'flex' : 'none';

    // THE REVEAL: Secret Dungeon
    if (isSuperAdmin && elements.secretDungeon) {
        elements.secretDungeon.classList.remove('slds-hide');
        elements.secretDungeon.style.display = 'flex';
        console.log("🔓 Secret Dungeon access authorized.");
    }

    // Permission Override: Super Admins see all cards
    const permMap = {
        'card-inventory': isSuperAdmin || parseBool(user.access_inventory),
        'card-deployments': isSuperAdmin || parseBool(user.access_deployments),
        'card-returns': isSuperAdmin || parseBool(user.access_returns),
        'card-merchants': isSuperAdmin || parseBool(user.access_merchants),
        'card-partners': isSuperAdmin || parseBool(user.access_partners)
    };

    Object.keys(permMap).forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = permMap[id] ? 'flex' : 'none';
    });
    
    if (window.Swal) Swal.close();
    if (typeof checkGlobalNotifications === 'function') checkGlobalNotifications();
}
