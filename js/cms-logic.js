/**
 * cms-logic.js - Secure Frontend Controller
 */
let pendingChanges = {};

/**
 * RULE 1 & 2 ENFORCEMENT: 
 * - Only super_admin can edit or delete a super_admin.
 * - Operations Admin can edit/delete anyone else.
 */

async function loadUsers() {
    try {
        const response = await fetch('/api/users?action=list');
        const result = await response.json();
        if (!result.success) throw new Error(result.message);

        const tbody = document.getElementById('user-list');
        tbody.innerHTML = ''; 
        
        const myRole = localStorage.getItem('pp_role') || "";
        const iAmSuper = (myRole === 'super_admin');

        result.data.forEach(user => {
            const isTargetSuper = (user.role === 'super_admin');
            const statusClass = user.is_active ? 'status-active' : 'status-pending';
            
            // SECURITY: Disable Edit/Del if target is Super Admin and I am not Super Admin
            const disableActions = isTargetSuper && !iAmSuper;

            const row = document.createElement('tr');
            // Inside result.data.forEach(user => { ... }) in cms-logic.js
row.innerHTML = `
    <td><strong>${user.first_name || ''}</strong></td>
    <td>${user.email || '---'}</td>
    <td><span class="status-badge ${statusClass}">${user.is_active ? 'Active' : 'Pending'}</span></td>
    <td style="text-align:center;"><input type="checkbox" ${user.access_inventory ? 'checked' : ''} onchange="queueChange('${user.userid}', 'access_inventory', this.checked)" ${disableActions ? 'disabled' : ''}></td>
    <td style="text-align:center;"><input type="checkbox" ${user.access_deployments ? 'checked' : ''} onchange="queueChange('${user.userid}', 'access_deployments', this.checked)" ${disableActions ? 'disabled' : ''}></td>
    <td style="text-align:center;"><input type="checkbox" ${user.access_returns ? 'checked' : ''} onchange="queueChange('${user.userid}', 'access_returns', this.checked)" ${disableActions ? 'disabled' : ''}></td>
    <td style="text-align:center;"><input type="checkbox" ${user.access_merchants ? 'checked' : ''} onchange="queueChange('${user.userid}', 'access_merchants', this.checked)" ${disableActions ? 'disabled' : ''}></td>
    
    <td style="text-align:center;"><input type="checkbox" ${user.access_jarvis ? 'checked' : ''} onchange="queueChange('${user.userid}', 'access_jarvis', this.checked)" ${disableActions ? 'disabled' : ''}></td>
    <td style="text-align:center;"><input type="checkbox" ${user.access_partners ? 'checked' : ''} onchange="queueChange('${user.userid}', 'access_partners', this.checked)" ${disableActions ? 'disabled' : ''}></td>
    
    <td><strong>${user.role}</strong></td>
    <td style="text-align:center;">
        <button class="slds-button slds-button_neutral slds-button_small" 
            onclick="editUser('${user.userid}', '${user.first_name}', '${user.email}', '${user.role}')" 
            ${disableActions ? 'disabled' : ''}>Edit</button>
        <button class="slds-button slds-button_destructive slds-button_small" 
            onclick="deleteUser('${user.userid}', '${user.first_name}')" 
            ${disableActions ? 'disabled' : ''}>Del</button>
    </td>`;
            tbody.appendChild(row);
        });
    } catch (err) {
        console.error("Fetch Error:", err);
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
    let roleOptions = `<option value="Standard User">Standard User</option><option value="Operations Admin">Operations Admin</option>`;
    if (myRole === 'super_admin') roleOptions += `<option value="super_admin">super_admin</option>`;

    const { value: formValues } = await Swal.fire({
        title: 'Enroll New User',
        html: `
            <div class="swal-grid">
                <label>Full Name</label><input id="swal-name" class="slds-input" placeholder="Enter full name">
                <label>Email</label><input id="swal-email" type="email" class="slds-input" placeholder="Enter email">
                <label>Role</label><select id="swal-role" class="slds-select">${roleOptions}</select>
            </div>`,
        showCancelButton: true,
        confirmButtonText: 'Enroll User',
        preConfirm: () => {
            return {
                first_name: document.getElementById('swal-name').value,
                email: document.getElementById('swal-email').value,
                role: document.getElementById('swal-role').value
                 // Default values for new enrollments
        access_jarvis: false,
        access_partners: false,
        access_inventory: false,
        access_deployments: false,
        access_returns: false,
        access_merchants: false
            }
        }
    });

    if (formValues) {
        const res = await fetch('/api/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'insert', payload: formValues, performerRole: myRole })
        });
        const result = await res.json();
        if (result.success) { loadUsers(); Swal.fire('Success', 'User enrolled', 'success'); }
    }
}
async function editUser(uid, name, email, role) {
    const myRole = localStorage.getItem('pp_role');
    
    // HARD GUARD: Block the function if an Operations Admin tries to trigger it for a Super Admin
    if (role === 'super_admin' && myRole !== 'super_admin') {
        Swal.fire('Access Denied', 'You cannot edit a Super Admin account.', 'error');
        return;
    }

    let roleOptions = `<option value="Standard User" ${role==='Standard User'?'selected':''}>Standard User</option>
                       <option value="Operations Admin" ${role==='Operations Admin'?'selected':''}>Operations Admin</option>`;
    if (myRole === 'super_admin') {
        roleOptions += `<option value="super_admin" ${role==='super_admin'?'selected':''}>super_admin</option>`;
    }

    const { value: formValues } = await Swal.fire({
        title: `Edit User: ${name}`,
        html: `
            <div class="swal-grid">
                <label>Full Name</label><input id="swal-name" class="slds-input" value="${name}">
                <label>Email</label><input id="swal-email" class="slds-input" value="${email}">
                <label>Role</label><select id="swal-role" class="slds-select">${roleOptions}</select>
            </div>`,
        showCancelButton: true,
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
        if ((await response.json()).success) { loadUsers(); Swal.fire('Updated!', '', 'success'); }
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
