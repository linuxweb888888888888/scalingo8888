const express = require('express');
const app = express();
const port = 3000;

app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Hello Node</title>
            <style>
                body { 
                    background: #0b0e11; 
                    color: #fcd535; 
                    display: flex; 
                    justify-content: center; 
                    align-items: center; 
                    height: 100vh; 
                    margin: 0; 
                    font-family: sans-serif; 
                }
                h1 { font-size: 4rem; border-bottom: 2px solid #333; padding-bottom: 10px; }
            </style>
        </head>
        <body>
            <h1>Welcome to Node.js</h1>
        </body>
        </html>
    `);
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
