import{documents}from'../../lib/documents';export default function handler(req,res){res.json({q:String(req.query.q||''),results:documents.filter(d=>d.title.includes(String(req.query.q||'')))})}
