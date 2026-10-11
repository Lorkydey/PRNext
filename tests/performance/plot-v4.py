"""Standalone scientific figures from completed, verified report samples.

Run report-v4.py, this script (matplotlib required), then report-v4.py again.
The HTML checks the source digest before embedding a figure.
"""
import hashlib, json, pathlib
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

BASE=pathlib.Path(__file__).resolve().parents[2]/'artifacts/performance-v4'
data=json.loads((BASE/'summary.json').read_text(encoding='utf-8'))
assert data['soak']['state']=='complet','No complete one-hour result to plot'
rows=data['soak']['series'];out=BASE/'plots';out.mkdir(exist_ok=True)
digest=hashlib.sha256(json.dumps(rows,sort_keys=True).encode()).hexdigest()
plt.rcParams.update({'font.family':'DejaVu Sans','font.size':10,'axes.spines.top':False,'axes.spines.right':False,'svg.fonttype':'none'})
for key,title,ylabel,color in [('rssMiB','RSS cumulée des processus serveur','Mio','#176358'),('handles','Handles Windows cumulés','Handles','#8d5e24')]:
    fig,ax=plt.subplots(figsize=(10,2.9),layout='constrained')
    ax.plot([r['seconds']/60 for r in rows],[r[key] for r in rows],color=color,linewidth=1.15)
    ax.set(title=title,xlabel='Temps de charge mixte (minutes)',ylabel=ylabel,xlim=(0,60),ylim=(0,None))
    ax.grid(axis='y',alpha=.2);ax.set_xticks(range(0,61,10))
    for extension in ['svg','png']:
        fig.savefig(out/('soak-'+key+'.'+extension),dpi=180,metadata={'Creator':'PRNext performance plot-v4.py'} if extension=='svg' else None)
    plt.close(fig)
    (out/('soak-'+key+'.json')).write_text(json.dumps({'sourceSha256':digest,'candidateBinarySha256':data['candidateBinarySha256'],'matplotlib':matplotlib.__version__,'samples':len(rows),'sampling':'one in ten server samples, approximately 5 seconds; full raw samples retained'},indent=2))
print('Two standalone SVG/PNG figures generated from complete endurance samples')
