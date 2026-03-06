/**
 * cms-logic.js - Secure Frontend Controller
 */
let pendingChanges = {};

async function fetchUsers() {
    try {
        const response = await fetch('/api/users?action=list');
        const result = await response.json();
        
        if (!result.success) throw new Error(result.message);

        const users = result.data;
        const tbody = document.getElementById('user-list');
        tbody.innerHTML = ''; 
        
        const myRole = (sessionStorage.getItem('pp_role') || "").toLowerCase();
        const iAmSuper = myRole.includes('super');

        users.forEach(user => {
            const targetRole = (user.role || "").toLowerCase();
            if (!iAmSuper && targetRole.includes('super')) return; 

            const row = document.createElement('tr');
            row.innerHTML = `
                <td><strong>${user.first_name || ''}</strong></td>
                <td>${user.email || '---'}</td>
                <td><code>${user.passkey || '----'}</code></td>
                <td style="text-align:center;"><input type="checkbox" ${user.access_inventory ? 'checked' : ''} onchange="queueChange('${user.userid}', 'access_inventory', this.checked)"></td>
                <td style="text-align:center;"><input type="checkbox" ${user.access_deployments ? 'checked' : ''} onchange="queueChange('${user.userid}', 'access_deployments', this.checked)"></td>
                <td style="text-align:center;"><input type="checkbox" ${user.access_returns ? 'checked' : ''} onchange="queueChange('${user.userid}', 'access_returns', this.checked)"></td>
                <td style="text-align:center;"><input type="checkbox" ${user.access_merchants ? 'checked' : ''} onchange="queueChange('${user.userid}', 'access_merchants', this.checked)"></td>
                <td><span class="slds-badge ${targetRole.includes('admin') ? 'slds-badge_info' : ''}">${user.role}</span></td>
                <td class="action-btns">
                    <button class="slds-button slds-button_neutral slds-button_small" onclick="editUser('${user.userid}', '${user.first_name}', '${user.email || ''}', '${user.passkey || ''}', '${user.role}')">Edit</button>
                    <button class="slds-button slds-button_destructive slds-button_small" onclick="deleteUser('${user.userid}', '${user.first_name}')">Del</button>
                </td>`;
            tbody.appendChild(row);
        });
    } catch (err) {
        console.error("Fetch Error:", err);
        document.getElementById('user-list').innerHTML = '<tr><td colspan="9" style="color:red;">Failed to load users. Check console.</td></tr>';
    }
}

function queueChange(userId, field, value) {
    if (!pendingChanges[userId]) pendingChanges[userId] = {};
    pendingChanges[userId][field] = value;
    document.getElementById('save-all-btn').style.display = 'inline-block';
    document.getElementById('unsaved-warning').style.display = 'block';
}

async function saveAllChanges() {
    Swal.fire({ title: 'Saving...', didOpen: () => Swal.showLoading() });
    try {
        const response = await fetch('/api/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'updateBatch', payload: pendingChanges })
        });
        const result = await response.json();
        if (result.success) {
            pendingChanges = {};
            document.getElementById('save-all-btn').style.display = 'none';
            document.getElementById('unsaved-warning').style.display = 'none';
            await fetchUsers();
            Swal.fire('Saved!', '', 'success');
        }
    } catch (err) {
        Swal.fire('Error', 'Save failed', 'error');
    }
}

// Gatekeeper Initialization
window.onload = () => {
    const role = (sessionStorage.getItem('pp_role') || "").toLowerCase();
    
    // Only show content if user is an ADMIN
    if (role.includes('admin')) {
        document.getElementById('page-content').style.display = 'block';
        fetchUsers();
    } else {
        // Redirect non-admins back to the hub
        window.location.href = 'index.html';
    }
};