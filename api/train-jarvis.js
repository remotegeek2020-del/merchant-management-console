import { createClient } from '@supabase/supabase-js';
import { validateSession, sessionErrorResponse } from './_validate.js';

export default async function handler(req, res) {
    const session = await validateSession(req);
    if (!session) return sessionErrorResponse(res);

    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const { topic, logic, userId } = req.body;
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    try {
      const { data, error } = await supabase
    .from('jarvis_knowledge')
    .insert([{ 
        topic: topic, 
        correct_logic: logic, // Maps the UI input to the DB column
        verified_by: userId 
    }]);

        if (error) throw error;
        return res.status(200).json({ success: true });
    } catch (err) {
        console.error("Training Error:", err);
        return res.status(500).json({ success: false, message: err.message });
    }
}
