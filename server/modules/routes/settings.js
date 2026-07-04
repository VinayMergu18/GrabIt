const express = require('express');
const router = express.Router();
const { getSettings, updateSettings, resetSettings } = require('../db');
const { refreshCookies } = require('../cookies');

router.get('/', (req, res) => res.json(getSettings()));
router.patch('/:section', (req, res) => {
  const { section } = req.params;
  const updated = updateSettings(section, req.body);
  res.json(updated);
});
router.post('/reset', (req, res) => res.json(resetSettings()));
router.post('/refresh-cookies', async (req, res) => {
  const ok = await refreshCookies();
  res.json({ ok, message: ok ? 'Cookies refreshed' : 'Failed to extract cookies' });
});

module.exports = router;
