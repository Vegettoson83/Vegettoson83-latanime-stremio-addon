#!/usr/bin/env node

const express = require('express');
const cors = require('cors');
const addonInterface = require('./addon');

const app = express();
app.use(cors());

const port = process.env.PORT || 7000;

// Stremio addon routes
app.get('/manifest.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(addonInterface.manifest);
});

app.get('/:resource/:type/:id.json', (req, res) => {
    const { resource, type, id } = req.params;
    addonInterface.get({ resource, type, id, extra: req.query })
        .then(resp => {
            res.setHeader('Content-Type', 'application/json');
            res.send(resp);
        })
        .catch(err => {
            console.error(err);
            res.status(500).send({ err: 'handler error' });
        });
});

app.listen(port, () => {
    console.log(`Addon server listening on port ${port}`);
});
