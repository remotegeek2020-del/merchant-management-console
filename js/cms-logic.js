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

async function addUser() {
    const { value: formValues } = await Swal.fire({
        title: 'Enroll New User',
        html: `
            <div class="swal-grid">
                <label>User ID</label><input id="swal-id" class="slds-input" placeholder="e.g. josh123">
                <label>First Name</label><input id="swal-name" class="slds-input">
                <label>Email</label><input id="swal-email" class="slds-input">
                <label>Passkey</label><input id="swal-pass" class="slds-input">
                <label>Role</label>
                <select id="swal-role" class="slds-select">
                    <option value="USER">USER</option>
                    <option value="ADMIN">ADMIN</option>
                </select>
            </div>`,
        confirmButtonColor: '#004990',
        preConfirm: () => {
            return {
                userid: document.getElementById('swal-id').value,
                first_name: document.getElementById('swal-name').value,
                email: document.getElementById('swal-email').value,
                passkey: document.getElementById('swal-pass').value,
                role: document.getElementById('swal-role').value
            }
        }
    });

    if (formValues) {
        const response = await fetch('/api/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'insert', payload: formValues })
        });
        const result = await response.json();
        if (result.success) {
            Swal.fire('Success', 'User enrolled!', 'success');
            fetchUsers();
        }
    }
}

async function editUser(uid, name, email, pass, role) {
    const { value: formValues } = await Swal.fire({
        title: `Edit User: ${name}`,
        html: `
            <div class="swal-grid">
                <label>First Name</label><input id="swal-name" class="slds-input" value="${name}">
                <label>Email</label><input id="swal-email" class="slds-input" value="${email}">
                <label>Passkey</label><input id="swal-pass" class="slds-input" value="${pass}">
                <label>Role</label>
                <select id="swal-role" class="slds-select">
                    <option value="USER" ${role==='USER'?'selected':''}>USER</option>
                    <option value="ADMIN" ${role==='ADMIN'?'selected':''}>ADMIN</option>
                </select>
            </div>`,
        showCancelButton: true,
        confirmButtonText: 'Save Changes',
        confirmButtonColor: '#004990',
        preConfirm: () => {
            return {
                first_name: document.getElementById('swal-name').value,
                email: document.getElementById('swal-email').value,
                passkey: document.getElementById('swal-pass').value,
                role: document.getElementById('swal-role').value
            }
        }
    });

    if (formValues) {
        const response = await fetch('/api/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'updateSingle', userid: uid, payload: formValues })
        });
        const result = await response.json();
        if (result.success) {
            Swal.fire({ title: 'Updated!', icon: 'success', timer: 1500, showConfirmButton: false });
            fetchUsers();
        }
    }
}

async function deleteUser(uid, name) {
    const result = await Swal.fire({
        title: 'Are you sure?',
        text: `Delete user ${name}? This cannot be undone.`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#d33',
        confirmButtonText: 'Yes, delete!'
    });
    
    if (result.isConfirmed) {
        const response = await fetch('/api/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'delete', userid: uid })
        });
        const resultJson = await response.json();
        if (resultJson.success) {
            Swal.fire('Deleted!', '', 'success');
            fetchUsers();
        }
    }
}

window.onload = () => {
    const role = (sessionStorage.getItem('pp_role') || "").toLowerCase();
    if (role.includes('admin')) {
        document.getElementById('page-content').style.display = 'block';
        fetchUsers();
    } else {
        window.location.href = 'index.html';
    }
};
