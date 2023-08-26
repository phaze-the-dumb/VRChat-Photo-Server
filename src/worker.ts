import * as Realm from 'realm-web';

const {
  BSON: { ObjectId },
} = Realm;

export interface Env {
	MONGO_APP: string;
	MONGO_KEY: string;
	APP_ID: string;
	APP_TOKEN: string;
	FILE_PREFIX: string;

	BUCKET: R2Bucket;
}

let users: any;

export default {
	async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		if(!users){
			let app = new Realm.App({ id: env.MONGO_APP });
			let user = await app.logIn(Realm.Credentials.apiKey(env.MONGO_KEY));

			let mongo = user.mongoClient('mongodb-atlas');
			users = mongo.db('Users').collection('Users');
		}

		let url = new URL(req.url);
		let token = url.searchParams.get('token') || req.headers.get('auth');

		if(req.method === 'GET'){
			switch(url.pathname){
				case '/api/v1/status':
					return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
				case '/api/v1/auth':
					if(!token)return Response.redirect('https://id.phazed.xyz/api/v1/oauth?app='+env.APP_ID);

					let dataReq = await fetch('https://id.phazed.xyz/api/v1/user/@me', { headers: { auth: token, oauth: env.APP_TOKEN } });
					let data: any = await dataReq.json();

					if(!data.ok)
						return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

					let trashReq = await fetch('https://id.phazed.xyz/api/v1/oauth/token', { method: 'DELETE', headers: { auth: token } });
					let trash: any = await trashReq.json();

					if(!trash.ok)
						console.log('Failed to trash token for user '+data.username);

					let userData = await users.findOne({ _id: data.id });
					if(!userData){
						let tokenReq = await fetch('https://csprng.xyz/v1/api');
						let token: any = await tokenReq.json()

						userData = {
							_id: data.id,
							username: data.username,
							avatar: data.avatar,
							used: 0,
							storage: 0,
							token: token.Data,
							settings: {
								enableSync: false
							}
						}

						await users.insertOne(userData);
					}

					if(userData.username !== data.username)
						await users.updateOne({ _id: data.id }, { $set: { username: data.username } });

					if(userData.avatar !== data.avatar)
						await users.updateOne({ _id: data.id }, { $set: { avatar: data.avatar } });

					return Response.redirect('http://127.0.0.1:53413/api/v1/auth/callback?token='+encodeURIComponent(userData.token));
				case '/api/v1/account':
					if(!token)
						return new Response(JSON.stringify({ ok: false, error: 'No token provided' }), { headers: { 'Content-Type': 'application/json' } });

					let user = await users.findOne({ token: token });
					if(!user)return new Response(JSON.stringify({ ok: false, error: 'Invalid token' }), { headers: { 'Content-Type': 'application/json' } });

					let filteredUser: any = {
						_id: user._id,
						username: user.username,
						avatar: user.avatar,
						used: user.used,
						storage: user.storage,
						settings: user.settings
					}

					return new Response(JSON.stringify({ ok: true, user: filteredUser }), { headers: { 'Content-Type': 'application/json' } });
				case '/api/v1/photos/exists':
					if(!token)
						return new Response(JSON.stringify({ ok: false, error: 'No token provided' }), { headers: { 'Content-Type': 'application/json' } });

					let userAcc = await users.findOne({ token: token });
					if(!userAcc)return new Response(JSON.stringify({ ok: false, error: 'Invalid token' }), { headers: { 'Content-Type': 'application/json' } });

					if(!url.searchParams.get('photo')){
						let files = await env.BUCKET.list({ prefix: env.FILE_PREFIX + userAcc._id });

						let truncated = files.truncated;
						let cursor = truncated ? files.cursor : undefined;

						while(truncated){
							let next = await env.BUCKET.list({ prefix: env.FILE_PREFIX + userAcc._id, cursor: cursor });
							files.objects.push(...next.objects);

							truncated = next.truncated;
							cursor = next.cursor;
						}

						return new Response(JSON.stringify({ ok: true, files: files.objects.map(x => x.key.split('/').pop()) }), { headers: { 'Content-Type': 'application/json' } });
					}

					let exists = await env.BUCKET.head(env.FILE_PREFIX + userAcc._id + '/' + url.searchParams.get('photo'));
					if(!exists)return new Response(JSON.stringify({ ok: true, exists: false }), { headers: { 'Content-Type': 'application/json' } });

					return new Response(JSON.stringify({ ok: true, exists: true }), { headers: { 'Content-Type': 'application/json' } });
				case '/api/v1/photos':
					let photo = url.searchParams.get('photo');
					if(!photo)
						return new Response(JSON.stringify({ ok: false, error: 'No photo specified' }), { headers: { 'Content-Type': 'application/json' } });

					if(!token)
						return new Response(JSON.stringify({ ok: false, error: 'No token provided' }), { headers: { 'Content-Type': 'application/json' } });

					let targetUser = await users.findOne({ token: token });
					if(!targetUser)return new Response(JSON.stringify({ ok: false, error: 'Invalid token' }), { headers: { 'Content-Type': 'application/json' } });

					let object = await env.BUCKET.get(env.FILE_PREFIX + targetUser._id + '/' + photo);
					if(!object)return new Response(JSON.stringify({ ok: false, error: 'Photo doesn\'t exist' }), { headers: { 'Content-Type': 'application/json' } });

					let headers = new Headers();
					object.writeHttpMetadata(headers);
					headers.set('etag', object.httpEtag);

					return new Response(object.body, { headers });
				default:
					return new Response('404 Not Found', { status: 404 });
			}
		} else if(req.method === 'PUT'){
			switch(url.pathname){
				case '/api/v1/photos':
					if(req.headers.get('content-type') !== 'image/png')
						return new Response(JSON.stringify({ ok: false, error: 'Invalid content type' }), { headers: { 'Content-Type': 'application/json' } });

					let filename = req.headers.get('filename');
					if(!filename || !filename.match(/VRChat_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}.[0-9]{3}_[0-9]{4}x[0-9]{4}.png/gm))
						return new Response(JSON.stringify({ ok: false, error: 'Invaild file name' }), { headers: { 'Content-Type': 'application/json' } });

					if(!token)
						return new Response(JSON.stringify({ ok: false, error: 'No token provided' }), { headers: { 'Content-Type': 'application/json' } });

					let user = await users.findOne({ token: token });
					if(!user)
						return new Response(JSON.stringify({ ok: false, error: 'User not found' }), { headers: { 'Content-Type': 'application/json' } });

					await env.BUCKET.put(env.FILE_PREFIX + user._id + '/' + filename, req.body);
					let fileSize = (await env.BUCKET.head(env.FILE_PREFIX + user._id + '/' + filename))!.size;

					await users.updateOne({ _id: user._id }, { $inc: { used: fileSize } });
					console.log('Uploaded photo to '+user.username+' name '+filename+' size '+fileSize);

					return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
				default:
					return new Response('404 Not Found', { status: 404 });
			}
		} else if(req.method === 'DELETE'){
			switch(url.pathname){
				case '/api/v1/photos':
					let filename = url.searchParams.get('photo');

					if(!filename || !filename.match(/VRChat_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}.[0-9]{3}_[0-9]{4}x[0-9]{4}.png/gm))
						return new Response(JSON.stringify({ ok: false, error: 'Invaild file name' }), { headers: { 'Content-Type': 'application/json' } });

					if(!token)
						return new Response(JSON.stringify({ ok: false, error: 'No token provided' }), { headers: { 'Content-Type': 'application/json' } });

					let user = await users.findOne({ token: token });
					if(!user)
						return new Response(JSON.stringify({ ok: false, error: 'User not found' }), { headers: { 'Content-Type': 'application/json' } });

					let file = await env.BUCKET.head(env.FILE_PREFIX + user._id + '/' + filename);
					if(!file)return new Response(JSON.stringify({ ok: false, error: 'File not found' }), { headers: { 'Content-Type': 'application/json' } });

					let fileSize = file.size;
					await env.BUCKET.delete(env.FILE_PREFIX + user._id + '/' + filename);

					await users.updateOne({ _id: user._id }, { $inc: { used: -fileSize } });
					console.log('Deleted photo of '+user.username+' name '+filename);

					return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
				default:
					return new Response('404 Not Found', { status: 404 });
			}
		} else
			return new Response('404 Not Found', { status: 404 });
	},
};
