async function triggerBulkNoteUpload() {
    console.log("Dungeon Hack: Note Injector Started"); // Check console for this

    const { value: file } = await Swal.fire({
        title: 'Select Notes CSV',
        input: 'file',
        inputAttributes: { 'accept': '.csv' },
        confirmButtonColor: '#6366f1'
    });

    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
        const text = e.target.result;
        const lines = text.split('\n').filter(l => l.trim());
        const headers = lines[0].split(',').map(h => h.trim());
        
        console.log("CSV Headers Found:", headers);

        // 1. MAPPING UI
        const { value: mapping } = await Swal.fire({
            title: 'Map CSV Columns',
            html: `
                <div style="text-align:left; font-size:13px;">
                    <p style="margin-bottom:10px; color:#64748b;">Match your CSV headers to the Database fields:</p>
                    ${['merchant_id', 'title', 'body', 'userid', 'created_date'].map(field => `
                        <div style="margin-bottom:8px;">
                            <label style="font-weight:bold; display:block; color:#1e293b;">${field.replace('_', ' ').toUpperCase()}:</label>
                            <select id="map-${field}" class="slds-select" style="font-size:12px; height:32px;">
                                <option value="">-- Skip / Not in CSV --</option>
                                ${headers.map(h => `<option value="${h}" ${h.toLowerCase().includes(field.split('_')[0]) ? 'selected' : ''}>${h}</option>`).join('')}
                            </select>
                        </div>
                    `).join('')}
                </div>
            `,
            focusConfirm: false,
            preConfirm: () => {
                return {
                    merchant_id: document.getElementById('map-merchant_id').value,
                    title: document.getElementById('map-title').value,
                    body: document.getElementById('map-body').value,
                    userid: document.getElementById('map-userid').value,
                    created_date: document.getElementById('map-created_date').value
                }
            }
        });

        if (!mapping) return;

        // 2. PARSE DATA
        const rows = lines.slice(1);
        const notes = rows.map(row => {
            // This handles simple CSV splitting
            const cols = row.split(',');
            const data = {};
            headers.forEach((h, index) => { data[h] = cols[index]?.trim(); });
            
            return {
                merchant_id: data[mapping.merchant_id],
                title: data[mapping.title] || 'Bulk Note',
                body: data[mapping.body],
                userid: data[mapping.userid],
                created_at: data[mapping.created_date] 
            };
        }).filter(n => n.merchant_id && n.body);

        if (notes.length === 0) {
            Swal.fire('Error', 'No valid rows found to inject.', 'error');
            return;
        }

        // 3. INJECT VIA API
        Swal.fire({ title: 'Injecting...', didOpen: () => Swal.showLoading() });
        
        try {
            const res = await fetch('/api/bulk-notes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ notes })
            });
            const result = await res.json();

            if (result.failed > 0) {
                Swal.fire({
                    title: 'Injection Report',
                    icon: 'warning',
                    html: `
                        <div style="text-align:left; font-size:13px;">
                            <p style="color:green;"><b>Successfully Added:</b> ${result.success}</p>
                            <p style="color:red; margin-top:5px;"><b>Failed/Skipped:</b> ${result.failed}</p>
                            <hr>
                            <p><b>The following IDs were not found in the Database:</b></p>
                            <div style="max-height:150px; overflow-y:auto; background:#fff1f2; padding:8px; border-radius:8px; margin-top:5px; font-family:monospace; color:#991b1b; border:1px solid #fecaca;">
                                ${result.skipped_ids.join('<br>')}
                            </div>
                        </div>
                    `
                });
            } else {
                Swal.fire('Hack Success', `Successfully injected ${result.success} notes.`, 'success');
            }
        } catch (err) {
            Swal.fire('API Error', 'Could not reach the bulk-notes server.', 'error');
        }
    };
    reader.readAsText(file);
}
