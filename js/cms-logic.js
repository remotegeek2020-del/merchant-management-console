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
async function loadUsers() {
    try {
        // We call our Vercel API, NOT Supabase directly
        const response = await fetch('/api/users?action=list');
        const result = await response.json();

        if (result.success) {
            const tbody = document.getElementById('user-list');
            if (!result.data || result.data.length === 0) {
                tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;">No users found.</td></tr>';
                return;
            }

            tbody.innerHTML = result.data.map(user => {
                const statusClass = user.is_active ? 'status-active' : 'status-pending';
                const statusText = user.is_active ? 'Active' : 'Pending';
                
                return `
                    <tr>
                        <td>${user.first_name}</td>
                        <td>${user.email}</td>
                        <td><span class="status-badge ${statusClass}">${statusText}</span></td>
                        <td style="text-align:center;">${user.access_inventory ? '✅' : '❌'}</td>
                        <td style="text-align:center;">${user.access_deployments ? '✅' : '❌'}</td>
                        <td style="text-align:center;">${user.access_returns ? '✅' : '❌'}</td>
                        <td style="text-align:center;">${user.access_merchants ? '✅' : '❌'}</td>
                        <td><strong>${user.role}</strong></td>
                        <td style="text-align:center;">
                            <button onclick="editUser('${user.userid}')" class="slds-button slds-button_neutral slds-button_small">Edit</button>
                            ${user.role !== 'super_admin' ? `<button onclick="deleteUser('${user.userid}')" class="slds-button slds-button_destructive slds-button_small">Del</button>` : ''}
                        </td>
                    </tr>
                `;
            }).join('');
        }
    } catch (err) {
        console.error("CMS Load Error:", err);
        document.getElementById('user-list').innerHTML = '<tr><td colspan="9" style="color:red; text-align:center;">Failed to connect to API.</td></tr>';
    }
}
function addUser() {
    const myRole = localStorage.getItem('pp_role');
    
    // Rule 2 Enforcement: Hide 'super_admin' from the role dropdown if I am not one
    let roleOptions = `
        <option value="Standard User">Standard User</option>
        <option value="Operations Admin">Operations Admin</option>
    `;
    
    if (myRole === 'super_admin') {
        roleOptions += `<option value="super_admin">Super Admin (God Mode)</option>`;
    }

    Swal.fire({
        title: 'Enroll New Staff',
        html: `
            <input id="new-first" class="swal2-input" placeholder="First Name">
            <input id="new-email" class="swal2-input" placeholder="Email">
            <select id="new-role" class="swal2-select">${roleOptions}</select>
                
                <label>Email</label>
                <input id="swal-email" type="email" class="slds-input">
                
                <label>Role</label>
                <select id="swal-role" class="slds-select">
                    <option value="Standard User">Standard User</option>
                    <option value="Operations Admin">Operations Admin</option>
                    <option value="Super Admin">Super Admin</option>
                </select>
            </div>
            <div style="margin-top: 15px; font-size: 12px; color: #64748b; text-align: center;">
                An invitation email will be sent to the user to set their password.
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
                body: JSON.stringify({ action: 'insert', payload: formValues })
            });
            const result = await res.json();
            if (result.success) {
                Swal.fire('Enrolled', 'Invitation generated and user added.', 'success');
                // Refresh the table (assuming you have a loadUsers function)
                if (typeof loadUsers === 'function') loadUsers();
            } else {
                throw new Error(result.message);
            }
        } catch (err) {
            Swal.fire('Error', err.message, 'error');
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
