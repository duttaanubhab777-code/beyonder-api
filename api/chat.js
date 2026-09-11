export default async function handler(req, res) {
    // 1. CORS Headers
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
    );

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    if (req.method !== "POST") {
        return res.status(405).json({ error: "Only POST allowed" });
    }

    try {
        const { provider, ...bodyData } = req.body;

        const groqModels = ['gpt-oss', 'qwen', 'groq'];

        if (groqModels.includes(provider)) {
            const apiKey = process.env.GROQ_API_KEY; 
            const url = 'https://api.groq.com/openai/v1/chat/completions';

            let selectedModel = "";
            if (provider === 'gpt-oss') selectedModel = "openai/gpt-oss-120b";
            else if (provider === 'qwen') selectedModel = "qwen/qwen3.8-27b";
            else if (provider === 'groq') selectedModel = "groq/compound";

            let groqMessages = [];

            if (bodyData.systemInstruction?.parts?.[0]?.text) {
                groqMessages.push({ role: "system", content: bodyData.systemInstruction.parts[0].text });
            }

            if (bodyData.contents) {
                bodyData.contents.forEach(msg => {
                    groqMessages.push({
                        role: msg.role === "model" ? "assistant" : "user",
                        content: msg.parts[0].text
                    });
                });
            }

            // 🛑 ম্যাজিক লজিক: মডেল অনুযায়ী প্যারামিটার সেট করা
            const groqBody = {
                model: selectedModel,
                messages: groqMessages
            };

            // যদি Qwen হয়, তাহলে আপনার দেওয়া স্পেশাল কোডগুলো অ্যাড হবে
            if (provider === 'qwen') {
                groqBody.max_completion_tokens = 1024;
                groqBody.reasoning_effort = "none";
            } else {
                // বাকিদের জন্য নরমাল টোকেন লিমিট
                groqBody.max_tokens = 1024;
            }

            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${apiKey}`
                },
                body: JSON.stringify(groqBody)
            });

            const data = await response.json();

            // কোনো মডেল এরর দিলে সেটা চ্যাটে দেখাবে
            if (data.error) {
                return res.status(200).json({
                    candidates: [
                        { content: { parts: [{ text: `⚠️ **Groq API Error:** ${data.error.message}` }] } }
                    ]
                });
            }

            const formattedResponse = {
                candidates: [
                    { content: { parts: [{ text: data.choices[0].message.content }] } }
                ]
            };

            return res.status(200).json(formattedResponse);
        } 
        
        else {
            const apiKey = process.env.GEMINI_API_KEY;
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${apiKey}`;

            const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(bodyData),
            });

            const data = await response.json();
            return res.status(200).json(data);
        }

    } catch (err) {
        console.error(err);
        return res.status(200).json({
            candidates: [
                { content: { parts: [{ text: `⚠️ **Server Error:** ${err.message}` }] } }
            ]
        });
    }
}
