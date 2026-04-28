
async function triggerBulkNoteUpload() {
    const { value: file } = await Swal.fire({
        title: 'Select CSV File',
        input: 'file',
        inputAttributes: { 'accept': '.csv' },
        confirmButtonColor: '#6366f1'
    });

    if (file) {
        const reader = new FileReader();
        reader.onload = async (e) => {
            const text = e.target.result;
            // Parses CSV rows while skipping header
            const rows = text.split('\n').slice(1).filter(r => r.trim()); 
            const notes = rows.map(r => {
                const cols = r.split(',');
                return { 
                    merchant_id: cols[0]?.trim(), 
                    title: cols[1]?.trim(), 
                    body: cols[2]?.trim() 
                };
            });

            Swal.fire({ title: 'Injecting...', didOpen: () => Swal.showLoading() });
            
            try {
                const res = await fetch('/api/bulk-notes', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        notes, 
                        author: localStorage.getItem('pp_userid') 
                    })
                });
                const result = await res.json();
                Swal.fire('Hack Success', `Added: ${result.success} | Failed: ${result.failed}`, 'success');
            } catch (err) {
                Swal.fire('Error', 'API Injection failed.', 'error');
            }
        };
        reader.readAsText(file);
    }
}
