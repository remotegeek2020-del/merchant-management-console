import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { notes, author } = req.body;

    let results = { success: 0, failed: 0, errors: [] };

    for (const note of notes) {
        // Find internal UUID from the merchant_id string
        const { data: merchant, error: mError } = await supabase
            .from('merchants')
            .select('id')
            .eq('merchant_id', note.merchant_id)
            .single();

        if (merchant) {
            const { error: nError } = await supabase.from('merchant_notes').insert([{
                merchant_id: merchant.id,
                title: note.title || 'Bulk System Note',
                body: note.body,
                created_by: author
            }]);

            if (!nError) results.success++;
            else results.failed++;
        } else {
            results.failed++;
            results.errors.push(`Merchant ID ${note.merchant_id} not found.`);
        }
    }

    return res.status(200).json(results);
}
