import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, person_id } = req.body || {};

    try {
        if (action === 'get_partners_list') {
            // 1. Get Persons (Partners) using the correct 'full_name' column
            const { data: persons, error: pErr } = await supabase
                .from('persons')
                .select('id, full_name, email');
            if (pErr) throw pErr;

            // 2. Get Company Mappings
            const { data: mappings } = await supabase
                .from('company_person_mapping')
                .select(`person_id, company_id, companies(id, company_name)`);

            // 3. Get Agent Identifiers & their Parent hierarchy
            const { data: agentData } = await supabase
                .from('agent_identifiers')
                .select(`
                    id_string,
                    agents:agent_id (
                        id,
                        company_id,
                        parent_agent_id
                    )
                `);

            // 4. Get Merchant counts (Linking dba_name to the agent_id string)
            const { data: merchants } = await supabase
                .from('merchants')
                .select('agent_id, dba_name');

            // --- RECURSIVE STITCHING ---
            const finalData = persons.map(p => {
                // Find companies mapped to this person
                const myMappings = mappings?.filter(m => m.person_id === p.id) || [];
                
                const myCompanies = myMappings.map(m => {
                    const co = m.companies;
                    if (!co) return null;

                    // Find IDs owned by this company
                    const myAgentIds = agentData?.filter(ad => ad.agents?.company_id === co.id) || [];

                    return {
                        id: co.id,
                        name: co.company_name,
                        identifiers: myAgentIds.map(ai => {
                            // Count Merchants under this specific ID string (e.g., 23232)
                            const mCount = merchants?.filter(merc => merc.agent_id === ai.id_string).length || 0;
                            
                            // Check for Downline (Sub-partners reporting to this Agent ID)
                            const subCount = agentData?.filter(sub => sub.agents?.parent_agent_id === ai.agents?.id).length || 0;

                            // Check for Upline (If this Agent reports to someone else)
                            const hasUpline = ai.agents?.parent_agent_id ? true : false;

                            return {
                                id_string: ai.id_string,
                                merchant_count: mCount,
                                sub_partner_count: subCount,
                                is_sub_partner: hasUpline
                            };
                        })
                    };
                }).filter(Boolean);

                // Only show if they have at least one company
                if (myCompanies.length === 0) return null;

                return {
                    id: p.id,
                    name: p.full_name, // Corrected from first_name/last_name
                    email: p.email,
                    companies: myCompanies,
                    // Aggregated stats for the card
                    total_merchants: myCompanies.reduce((sum, co) => 
                        sum + co.identifiers.reduce((isum, id) => isum + id.merchant_count, 0), 0)
                };
            }).filter(Boolean);

            return res.status(200).json({ success: true, data: finalData });
        }

        return res.status(400).json({ success: false, message: "Invalid Action" });

    } catch (err) {
        console.error("Partners API Final Error:", err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
}
