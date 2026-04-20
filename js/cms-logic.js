/**
 * cms-logic.js - Secure Frontend Controller
 */
let pendingChanges = {};

// RULE 3: This function is called by the HTML Guard once authorized
async function loadUsers() {
    console.log("Loading users...");
    try {
        const response = await fetch('/api/users?action=list');
        const result = await response.json();
        
        if (!result.success) throw new Error(result.message);

        const users = result.data;
        const tbody = document.getElementById('user-list');
        tbody.innerHTML = ''; 
        
        // Check my own role for UI rules
        const myRole = (localStorage.getItem('pp_role') || "").toLowerCase();
        const iAmSuper = myRole.includes('super');

        users.forEach(user => {
            const targetRole = (user.role || "").toLowerCase();
            const statusClass = user.is_active ? 'status-active' : 'status-pending';
            const statusText = user.is_active ? 'Active' : 'Pending';

            const row = document.createElement('tr');
            row.innerHTML = `
                <td><strong>${user.first_name || ''}</strong></td>
                <td>${user.email || '---'}</td>
                <td><span class="status-badge ${statusClass}">${statusText}</span></td>
                <td style="text-align:center;"><input type="checkbox" ${user.access_inventory ? 'checked' : ''} onchange="queueChange('${user.userid}', 'access_inventory', this.checked)"></td>
                <td style="text-align:center;"><input type="checkbox" ${user.access_deployments ? 'checked' : ''} onchange="queueChange('${user.userid}', 'access_deployments', this.checked)"></td>
                <td style="text-align:center;"><input type="checkbox" ${user.access_returns ? 'checked' : ''} onchange="queueChange('${user.userid}', 'access_returns', this.checked)"></td>
                <td style="text-align:center;"><input type="checkbox" ${user.access_merchants ? 'checked' : ''} onchange="queueChange('${user.userid}', 'access_merchants', this.checked)"></td>
                <td><span class="slds-badge ${targetRole.includes('admin') ? 'slds-badge_info' : ''}">${user.role}</span></td>
                <td style="text-align:center;">
                    <button class="slds-button slds-button_neutral slds-button_small" onclick="editUser('${user.userid}', '${user.first_name}', '${user.email}', '${user.role}')">Edit</button>
                    ${user.role !== 'super_admin' ? `<button class="slds-button slds-button_destructive slds-button_small" onclick="deleteUser('${user.userid}', '${user.first_name}')">Del</button>` : ''}
                </td>`;
            tbody.appendChild(row);
        });
    } catch (err) {
        console.error("Fetch Error:", err);
        document.getElementById('user-list').innerHTML = '<tr><td colspan="9" style="color:red; text-align:center;">Failed to load users. Check console.</td></tr>';
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
            await loadUsers();
            Swal.fire('Saved!', '', 'success');
        }
    } catch (err) {
        Swal.fire('Error', 'Save failed', 'error');
    }
}

async function addUser() {
    const myRole = localStorage.getItem('pp_role');
    
    // RULE 2: Operations Admin cannot grant Super Admin role
    let roleOptions = `
        <option value="Standard User">Standard User</option>
        <option value="Operations Admin">Operations Admin</option>
    `;
    if (myRole === 'super_admin') {
        roleOptions += `<option value="super_admin">super_admin</option>`;
    }

    const { value: formValues } = await Swal.fire({
        title: 'Enroll New Staff',
        html: `
            <div class="swal-grid">
                <label>First Name</label>
                <input id="swal-name" class="slds-input">
                <label>Email</label>
                <input id="swal-email" type="email" class="slds-input">
                <label>Role</label>
                <select id="swal-role" class="slds-select">${roleOptions}</select>
            </div>
        `,
        focusConfirm: false,
        showCancelButton: true,
        confirmButtonText: 'Enroll User',
        confirmButtonColor: '#004990',
        preConfirm: () => {
            const name = document.getElementById('swal-name').value;
            const email = document.getElementById('swal-email').value;
            if (!name || !email) {
                Swal.showValidationMessage('Name and Email are required');
                return false;
            }
            return {
                first_name: name,
                email: email,
                role: document.getElementById('swal-role').value,
                access_inventory: false,
                access_deployments: false,
                access_returns: false,
                access_merchants: false
            };
        }
    });

    if (formValues) {
        try {
            const res = await fetch('/api/users', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    action: 'insert', 
                    payload: formValues,
                    performerRole: myRole // Send my role to API for verification
                })
            });
            const result = await res.json();
            if (result.success) {
                Swal.fire('Enrolled', 'Invitation sent.', 'success');
                loadUsers();
            } else {
                throw new Error(result.message);
            }
        } catch (err) {
            Swal.fire('Error', err.message, 'error');
        }
    }
}

async function editUser(uid, name, email, role) {
    const { value: formValues } = await Swal.fire({
        title: `Edit User: ${name}`,
        html: `
            <div class="swal-grid">
                <label>First Name</label><input id="swal-name" class="slds-input" value="${name}">
                <label>Email</label><input id="swal-email" class="slds-input" value="${email}">
                <label>Role</label>
                <select id="swal-role" class="slds-select">
                    <option value="Standard User" ${role==='Standard User'?'selected':''}>Standard User</option>
                    <option value="Operations Admin" ${role==='Operations Admin'?'selected':''}>Operations Admin</option>
                    <option value="super_admin" ${role==='super_admin'?'selected':''}>super_admin</option>
                </select>
            </div>`,
        showCancelButton: true,
        confirmButtonText: 'Save Changes',
        confirmButtonColor: '#004990',
        preConfirm: () => {
            return {
                first_name: document.getElementById('swal-name').value,
                email: document.getElementById('swal-email').value,
                role: document.getElementById('swal-role').value
            }
        }
    });

    if (formValues) {
        const response = await fetch('/api/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'updateBatch', payload: { [uid]: formValues } })
        });
        const result = await response.json();
        if (result.success) {
            Swal.fire({ title: 'Updated!', icon: 'success', timer: 1500, showConfirmButton: false });
            loadUsers();
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
            loadUsers();
        }
    }
}
