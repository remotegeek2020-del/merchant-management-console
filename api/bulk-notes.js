import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    // Only allow POST requests for security
    if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { notes } = req.body;

    let results = { success: 0, failed: 0, skipped_ids: [] };

    try {
        for (const note of notes) {
            // 1. Resolve the Merchant ID string to an internal UUID
            const { data: mData } = await supabase
                .from('merchants')
                .select('id')
                .eq('merchant_id', note.merchant_id)
                .single();

            if (!mData) {
                results.failed++;
                results.skipped_ids.push(note.merchant_id + " (Not Found)");
                continue;
            }

            // 2. Resolve the Author Name from the userid provided
            let authorName = 'System Injector';
            if (note.userid) {
                const { data: uData } = await supabase
                    .from('app_users')
                    .select('first_name, last_name')
                    .eq('userid', note.userid)
                    .single();
                if (uData) authorName = `${uData.first_name} ${uData.last_name}`;
            }

            // 3. Inject the Note
            const { error: insertError } = await supabase.from('merchant_notes').insert([{
                merchant_id: mData.id,
                title: note.title || 'Bulk System Note',
                body: note.body,
                created_by: authorName,
                // Use the date from the CSV if provided, else current time
                created_at: note.created_at || new Date().toISOString()
            }]);

            if (!insertError) {
                results.success++;
            } else {
                results.failed++;
                results.skipped_ids.push(note.merchant_id + " (DB Error)");
            }
        }

        return res.status(200).json(results);

    } catch (err) {
        console.error("Bulk Note Error:", err);
        return res.status(500).json({ success: false, message: err.message });
    }
}
