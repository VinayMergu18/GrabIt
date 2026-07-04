const express = require('express');
const router = express.Router();
const { getHistory, deleteHistory, clearHistory, searchHistory } = require('../db');
const { addToQueue } = require('../queue');

router.get('/', (req, res) => {
  const { q, platform, limit = 100 } = req.query;
  let history = q ? searchHistory(q) : getHistory();
  if (platform) history = history.filter(h => h.platform === platform);
  res.json(history.slice(0, parseInt(limit)));
});

router.delete('/all', (req, res) => { clearHistory(); res.json({ ok: true }); });
router.delete('/:id', (req, res) => { deleteHistory(req.params.id); res.json({ ok: true }); });

// Re-download
router.post('/:id/redownload', (req, res) => {
  const history = getHistory();
  const item = history.find(h => h.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });

  const queueId = addToQueue({
    url: item.url,
    action: item.action,
    title: item.title,
    platform: item.platform,
    options: item.options || {}
  });

  res.json({ id: queueId, queued: true });
});

module.exports = router;
