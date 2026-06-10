const axios = require('axios');
const express = require('express');

const app = express();
const port = process.env.PORT || 3000;

const API_URL = "https://api.paradice.in/api.php";
const API_KEY = "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJwYXJhZGljZS5pbiIsImF1ZCI6InBhcmFkaWNlLmluIiwiaWF0IjoxNzgxMDc0MTk3LCJuYmYiOjE3ODEwNzQxOTcsImRhdGEiOnsiaWQiOiIzMjc1NzIiLCJsb2dpbiI6IndlYndlYjg4ODgiLCJrZXkiOiJQZ0Z4WUhnMkk2bFpRVVM2aU1MUVRjaWxTaTFqMjR6TyJ9fQ.xX9ZnJlxNF8PIPFuhUHasX7LM9EyIClBzqO0sTN_2RljA6plqjVGG0dwkkxv88NlrvVY4t1guKUuLHGH8rPDCpZiX6RfpBRx_5dqBijcQBi0HY_ZmfR_oNH8wSs9Fft6iABBVbpUWc2vmpTvxeu47rFEZDidXDFcMKrXsNPSWGbigGpVmxfxqWKd9iDINhIpi_fV7RJeGiSyDpd-dwZaagMXZhyrAYX7erTM93h91eogyNaGmPI_4HkDeZf_2HRLhOQqM4DC29pe-oQBiRM4aRNpoz59MOi6_HNNtd1K0m4Um4IEJPLLHj4sespPRdQjc9l8K44pkejkALsOxve0NA";

// Try different common API patterns
async function discoverAPI() {
    console.log("Attempting to discover API structure...");
    
    // Try 1: GET with key as parameter
    try {
        const res1 = await axios.get(`${API_URL}?action=getBalance&api_key=${API_KEY}`);
        console.log("GET with params:", res1.data);
    } catch(e) { console.log("GET params failed"); }
    
    // Try 2: POST with JSON
    try {
        const res2 = await axios.post(API_URL, { 
            action: "getBalance", 
            api_key: API_KEY 
        }, { headers: { 'Content-Type': 'application/json' }});
        console.log("POST JSON:", res2.data);
    } catch(e) { console.log("POST JSON failed"); }
    
    // Try 3: POST form data
    const FormData = require('form-data');
    const form = new FormData();
    form.append('action', 'getBalance');
    form.append('api_key', API_KEY);
    try {
        const res3 = await axios.post(API_URL, form, { headers: form.getHeaders() });
        console.log("POST form:", res3.data);
    } catch(e) { console.log("POST form failed"); }
}

discoverAPI();

// Simple dashboard
app.get('/', (req, res) => {
    res.send(`
        <h1>Paradice.in API Discovery Tool</h1>
        <p>Check the console for API test results.</p>
        <p>Please share what you see when visiting ${API_URL} in your browser.</p>
    `);
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    console.log(`Please visit ${API_URL} in your browser and share what you see`);
});
