import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const { topic, logic, category, userId } = req.body;
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    try {
        const { data, error } = await supabase
            .from('jarvis_knowledge')
            .insert([{ 
                topic: topic, 
                correct_logic: logic, 
                category: category || 'general',
                verified_by: userId 
            }]);

        if (error) throw error;
        return res.status(200).json({ success: true });
    } catch (err) {
        console.error("Training Error:", err);
        return res.status(500).json({ success: false, message: err.message });
    }
}
