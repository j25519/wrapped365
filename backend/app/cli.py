"""Admin-only CLI. Run inside the API container; never serve via HTTP."""
import argparse
import datetime
import os
import secrets
from .db import connect
from .main import invite_digest

p=argparse.ArgumentParser()
p.add_argument('command',choices=['invite','cleanup'])
p.add_argument('--days',type=int,default=14)
a=p.parse_args()
with connect() as db:
    if a.command=='invite':
        code='MDB58-'+secrets.token_urlsafe(27)
        db.execute('INSERT INTO invitations(token_digest,expires_at) VALUES (%s,now()+(%s * interval \'1 day\'))',(invite_digest(code),a.days))
        db.commit()
        print('Invitation (displayed only once):',code)
    else:
        r=db.execute("DELETE FROM submissions WHERE state='staging' AND created_at<now()-interval '24 hours' RETURNING id").fetchall()
        db.execute("DELETE FROM auth_sessions WHERE expires_at<now()")
        db.commit()
        print('Expired staged submissions:',len(r))
