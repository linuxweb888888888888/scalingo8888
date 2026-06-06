const express = require('express');
const app = express();

// Use the PORT environment variable provided by Scalingo, or 3000 for local dev
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('<h1>Hello from Node.js on Scalingo!</h1>');
});

app.listen(port, () => {
  console.log(`Application is running on port ${port}`);
});
