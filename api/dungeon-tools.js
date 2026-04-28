import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { notes } = req.body;

    let results = { success: 0, failed: 0 };

    for (const note of notes) {
        try {
            // 1. Resolve Merchant UUID
            const { data: mData } = await supabase
                .from('merchants')
                .select('id')
                .eq('merchant_id', note.merchant_id)
                .single();

            // 2. Resolve Author Name from userid
            let authorName = 'System';
            if (note.userid) {
                const { data: uData } = await supabase
                    .from('app_users')
                    .select('first_name, last_name')
                    .eq('userid', note.userid)
                    .single();
                if (uData) authorName = `${uData.first_name} ${uData.last_name}`;
            }

            if (mData) {
                // 3. Insert Note with correct mapping
                const insertData = {
                    merchant_id: mData.id,
                    title: note.title,
                    body: note.body,
                    created_by: authorName,
                    // Use the date from CSV if provided, else Supabase default
                    created_at: note.created_at || new Date().toISOString()
                };

                const { error } = await supabase.from('merchant_notes').insert([insertData]);
                if (!error) results.success++;
                else results.failed++;
            } else {
                results.failed++;
            }
        } catch (err) {
            results.failed++;
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
