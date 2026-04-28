import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { notes } = req.body;

    let results = { success: 0, failed: 0, skipped_ids: [] };

    for (const note of notes) {
        try {
            // Check if merchant exists
            const { data: mData } = await supabase
                .from('merchants')
                .select('id')
                .eq('merchant_id', note.merchant_id)
                .single();

            if (!mData) {
                results.failed++;
                results.skipped_ids.push(note.merchant_id);
                continue; // Skip to next note
            }

            // Resolve Author Name
            let authorName = 'System';
            if (note.userid) {
                const { data: uData } = await supabase
                    .from('app_users')
                    .select('first_name, last_name')
                    .eq('userid', note.userid)
                    .single();
                if (uData) authorName = `${uData.first_name} ${uData.last_name}`;
            }

            // Insert
            const { error } = await supabase.from('merchant_notes').insert([{
                merchant_id: mData.id,
                title: note.title,
                body: note.body,
                created_by: authorName,
                created_at: note.created_at || new Date().toISOString()
            }]);

            if (!error) results.success++;
            else {
                results.failed++;
                results.skipped_ids.push(note.merchant_id);
            }
        } catch (err) {
            results.failed++;
            results.skipped_ids.push(note.merchant_id);
        }
    }

    return res.status(200).json(results);
}
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
