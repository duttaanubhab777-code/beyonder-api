export default async function handler(req, res) {
    // 1. CORS Headers (যেটা আপনি চেয়েছিলেন)
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
    );

    // Preflight request handle করা
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    if (req.method !== "POST") {
        return res.status(405).json({ error: "Only POST allowed" });
    }

    try {
        const { provider, ...bodyData } = req.body;

        // Groq-এর মডেলগুলো (GPT-OSS, Qwen, Llama)
        const groqModels = ['gpt-oss', 'qwen', 'llama'];

        if (groqModels.includes(provider)) {
            const apiKey = process.env.GROQ_API_KEY; 
            const url = 'https://api.groq.com/openai/v1/chat/completions';

            // মডেলের নাম ঠিক করা
            let selectedModel = "";
            if (provider === 'gpt-oss') selectedModel = "openai/gpt-oss-120b";
            else if (provider === 'qwen') selectedModel = "qwen/qwen3.8-27b";
            else if (provider === 'llama') selectedModel = "openai/gpt-oss-safeguard-20b";

            // Gemini-এর মেসেজ ফরম্যাট থেকে Groq/OpenAI ফরম্যাটে কনভার্ট করা
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

            const groqBody = {
                model: selectedModel,
                messages: groqMessages
            };

            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${apiKey}`
                },
                body: JSON.stringify(groqBody)
            });

            const data = await response.json();

            // রেসপন্সকে আবার Gemini-এর মতো করে সাজিয়ে ফ্রন্টএন্ডে পাঠানো
            // যাতে আপনার পুরোনো কোড কোনোভাবেই ব্রেক না করে
            const formattedResponse = {
                candidates: [
                    { content: { parts: [{ text: data.choices[0].message.content }] } }
                ]
            };
            
            return res.status(200).json(formattedResponse);
        } 
        
        // যদি ইউজার Gemini সিলেক্ট করে থাকে বা কোনো কারণে provider না আসে (Default)
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
        res.status(500).json({ error: "Server error" });
    }
}

