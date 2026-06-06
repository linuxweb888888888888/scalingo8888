const express = require('express');
const app = express();

// Scalingo provides the PORT variable automatically
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Node.js on Scalingo</title>
            <style>
                body { 
                    background: #0b0e11; 
                    color: #fcd535; 
                    display: flex; 
                    flex-direction: column;
                    justify-content: center; 
                    align-items: center; 
                    height: 100vh; 
                    margin: 0; 
                    font-family: sans-serif; 
                }
                h1 { font-size: 3rem; margin-bottom: 10px; }
                p { color: #848e9c; font-size: 1.2rem; }
            </style>
        </head>
        <body>
            <h1>Welcome to Node.js</h1>
            <p>Deployed successfully on Scalingo</p>
        </body>
        </html>
    `);
});

app.listen(port, () => {
    console.log(`App listening on port ${port}`);
});
