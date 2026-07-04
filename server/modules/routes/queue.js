const express = require('express');
const router = express.Router();
const { getQueue, getItem, cancelDownload, removeFromQueue, retryDownload, setPriority, clearCompleted } = require('../queue');

router.get('/', (req, res) => res.json(getQueue()));
router.get('/:id', (req, res) => {
  const item = getItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  res.json(item);
});
router.post('/:id/cancel', (req, res) => res.json({ ok: cancelDownload(req.params.id) }));
router.delete('/:id', (req, res) => { removeFromQueue(req.params.id); res.json({ ok: true }); });
router.post('/:id/retry', (req, res) => res.json({ ok: retryDownload(req.params.id) }));
router.post('/:id/priority', (req, res) => res.json({ ok: setPriority(req.params.id, req.body.priority || 0) }));
router.post('/clear-completed', (req, res) => { clearCompleted(); res.json({ ok: true }); });

module.exports = router;
