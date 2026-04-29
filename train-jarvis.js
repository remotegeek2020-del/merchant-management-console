import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ message: 'Sir, only POST is allowed here.' });

    const { topic, logic, category, userId } = req.body;
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    try {
        const { error } = await supabase.from('jarvis_knowledge').insert([{
            topic: topic,
            correct_logic: logic,
            category: category || 'general',
            verified_by: userId
        }]);

        if (error) throw error;
        return res.status(200).json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}
