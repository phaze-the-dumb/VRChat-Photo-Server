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
					if(url.searchParams.get('denied'))
						return new Response('<style>body{ background: black; color: white; }</style>Authentication flow finished, you may close this tab now <script>window.location.href = (\'vrcpm://auth-denied/\')</script>', { headers: { 'Content-Type': 'text/html' } });

					if(!token)return Response.redirect('https://id.phazed.xyz/?oauth='+env.APP_ID);

					let authReq = await fetch('https://api.phazed.xyz/id/v1/oauth/enable?apptoken='+env.APP_TOKEN+'&sesid='+url.searchParams.get('id'), { method: 'PUT' });
					let auth: any = await authReq.json();

					if(!auth.ok)
						return new Response(JSON.stringify(auth), { headers: { 'Content-Type': 'application/json' } });

					let dataReq = await fetch('https://api.phazed.xyz/id/v1/profile/@me?token='+token);
					let data: any = await dataReq.json();

					if(!data.ok)
						return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

					let trashReq = await fetch('https://api.phazed.xyz/id/v1/oauth?token='+token, { method: 'DELETE' });
					let trash: any = await trashReq.json();

					if(!trash.ok)
						console.log('Failed to trash token for user '+data.username);

					let userData = await users.findOne({ _id: data.id });
					if(!userData){
						userData = {
							_id: data.id,
							username: data.username,
							avatar: 'https://cdn.phazed.xyz/id/avatars/' + data.id + '/' + data.avatar + '.png',
							used: 0,
							storage: 0,
							token: crypto.randomUUID() + crypto.randomUUID() + crypto.randomUUID(),
							shareCode: Math.floor(Math.random() * 100000000).toString(),
							shares: [],
							blocks: [],
							serverVersion: '1.0',
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

					return new Response('<style>body{ background: black; color: white; }</style>Authentication flow finished, you may close this tab now <script>window.location.href = (\'vrcpm://auth-callback/'+userData.token+'\')</script>', { headers: { 'Content-Type': 'text/html' } });
				case '/api/v1/account':
					if(!token)
						return new Response(JSON.stringify({ ok: false, error: 'No token provided' }), { headers: { 'Content-Type': 'application/json' } });

					let user = await users.findOne({ token: token });
					if(!user)return new Response(JSON.stringify({ ok: false, error: 'Invalid token' }), { headers: { 'Content-Type': 'application/json' } });

					if(!user.shareCode){
						user.shareCode = Math.floor(Math.random() * 100000000).toString();
						users.updateOne({ _id: user._id }, { $set: { shareCode: user.shareCode } });
					}

					let filteredUser: any = {
						_id: user._id,
						username: user.username,
						avatar: user.avatar,
						used: user.used,
						storage: user.storage,
						settings: user.settings,
						shareCode: user.shareCode,
						serverVersion: user.serverVersion
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
						return new Response(JSON.stringify({ ok: false, error: 'No photo specified' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

					if(!token)
						return new Response(JSON.stringify({ ok: false, error: 'No token provided' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

					let targetUser = await users.findOne({ token: token });
					if(!targetUser)return new Response(JSON.stringify({ ok: false, error: 'Invalid token' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

					let object = await env.BUCKET.get(env.FILE_PREFIX + targetUser._id + '/' + photo);
					if(!object)return new Response(JSON.stringify({ ok: false, error: 'Photo doesn\'t exist' }), { status: 404, headers: { 'Content-Type': 'application/json' } });

					let headers = new Headers();
					object.writeHttpMetadata(headers);
					headers.set('etag', object.httpEtag);

					return new Response(object.body, { headers });
				case '/api/v1/user/byCode':
					if(!token)
						return new Response(JSON.stringify({ ok: false, error: 'No token provided' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

					let user2 = await users.findOne({ token: token });
					if(!user2)return new Response(JSON.stringify({ ok: false, error: 'Invalid token' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

					let shareCode = url.searchParams.get('code');
					if(!shareCode)return new Response(JSON.stringify({ ok: false, error: 'Invalid share code provided' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

					if(shareCode === user2.shareCode)return new Response(JSON.stringify({ ok: false, error: 'Cannot find user' }), { status: 404, headers: { 'Content-Type': 'application/json' } });

					let foundUser = await users.findOne({ shareCode: shareCode });
					if(!foundUser)return new Response(JSON.stringify({ ok: false, error: 'Cannot find user' }), { status: 404, headers: { 'Content-Type': 'application/json' } });

					if(foundUser.blocks.indexOf(user2._id) !== -1)return new Response(JSON.stringify({ ok: false, error: 'Cannot find user' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
					return new Response(JSON.stringify({ ok: true, user: { _id: foundUser._id, username: foundUser.username, avatar: foundUser.avatar } }), { headers: { 'Content-Type': 'application/json' } });
				case '/api/v1/share':
					if(!token)
						return new Response(JSON.stringify({ ok: false, error: 'No token provided' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

					let user3 = await users.findOne({ token: token });
					if(!user3)return new Response(JSON.stringify({ ok: false, error: 'Invalid token' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

					let shareCode1 = url.searchParams.get('code');
					if(!shareCode1)return new Response(JSON.stringify({ ok: false, error: 'Invalid share code provided' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

					let photo1 = url.searchParams.get('photo');
					if(!photo1)return new Response(JSON.stringify({ ok: false, error: 'Invalid photo provided' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

					if(shareCode1 === user3.shareCode)
						return new Response(JSON.stringify({ ok: false, error: 'Cannot find user' }), { status: 404, headers: { 'Content-Type': 'application/json' } });

					let photoExists = await env.BUCKET.head(env.FILE_PREFIX + user3._id + '/' + photo1);
					if(!photoExists)return new Response(JSON.stringify({ ok: false, error: 'Cannot find photo' }), { status: 404, headers: { 'Content-Type': 'application/json' } });

					let foundUser1 = await users.findOne({ shareCode: shareCode1 });
					if(!foundUser1)return new Response(JSON.stringify({ ok: false, error: 'Cannot find user' }), { status: 404, headers: { 'Content-Type': 'application/json' } });

					if(foundUser1.blocks.indexOf(user3._id) !== -1)
						return new Response(JSON.stringify({ ok: false, error: 'Cannot find user' }), { status: 404, headers: { 'Content-Type': 'application/json' } });

					if(foundUser1.shares.find(( x: any ) => x.userId === user3._id && x.photo === photo1))
						return new Response(JSON.stringify({ ok: false, error: 'Photo already shared with this user' }), { status: 401, headers: { 'Content-Type': 'application/json' } });

					await users.updateOne({ _id: foundUser1._id }, { $push: { "shares": { userId: user3._id, photo: photo1 } } });
					return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
				case '/api/v1/shares':
					if(!token)
						return new Response(JSON.stringify({ ok: false, error: 'No token provided' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

					let user1 = await users.findOne({ token: token });
					if(!user1)return new Response(JSON.stringify({ ok: false, error: 'Invalid token' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

					return new Response(JSON.stringify({ ok: true, shares: user1.shares }), { headers: { 'Content-Type': 'application/json' } });
				default:
					return new Response('404 Not Found', { status: 404 });
			}
		} else if(req.method === 'PUT'){
			switch(url.pathname){
				case '/api/v1/photos':
					if(req.headers.get('content-type') !== 'image/png')
						return new Response(JSON.stringify({ ok: false, error: 'Invalid content type' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

					let filename = req.headers.get('filename');
					if(!filename ||
						(!filename.match(/VRChat_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}.[0-9]{3}_[0-9]{4}x[0-9]{4}.png/gm) &&
						!filename.match(/VRChat_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}.[0-9]{3}_[0-9]{4}x[0-9]{4}_wrld_[a-z0-9]{8}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{12}.png/gm))
					)
						return new Response(JSON.stringify({ ok: false, error: 'Invaild file name' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

					if(!token)
						return new Response(JSON.stringify({ ok: false, error: 'No token provided' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

					let user = await users.findOne({ token: token });
					if(!user)
						return new Response(JSON.stringify({ ok: false, error: 'User not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });

					if(!user.settings.enableSync)
						return new Response(JSON.stringify({ ok: false, error: 'Not enough storage' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

					if(user.used >= user.storage)
						return new Response(JSON.stringify({ ok: false, error: 'Not enough storage' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

					let file = await env.BUCKET.head(env.FILE_PREFIX + user._id + '/' + filename);
					if(file)return new Response(JSON.stringify({ ok: true, error: 'File already exists' }), { headers: { 'Content-Type': 'application/json' } });

					await env.BUCKET.put(env.FILE_PREFIX + user._id + '/' + filename, req.body);
					let fileSize = (await env.BUCKET.head(env.FILE_PREFIX + user._id + '/' + filename))!.size;

					if(user.used + fileSize >= user.storage){
						await env.BUCKET.delete(env.FILE_PREFIX + user._id + '/' + filename);
						return new Response(JSON.stringify({ ok: false, error: 'Not enough storage' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
					}

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

					if(!filename ||
						(!filename.match(/VRChat_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}.[0-9]{3}_[0-9]{4}x[0-9]{4}.png/gm) &&
						!filename.match(/VRChat_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}.[0-9]{3}_[0-9]{4}x[0-9]{4}_wrld_[a-z0-9]{8}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{12}.png/gm))
					)
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
				case '/api/v1/allphotos':
					if(!token)
						return new Response(JSON.stringify({ ok: false, error: 'No token provided' }), { headers: { 'Content-Type': 'application/json' } });

					let user1 = await users.findOne({ token: token });
					if(!user1)
						return new Response(JSON.stringify({ ok: false, error: 'User not found' }), { headers: { 'Content-Type': 'application/json' } });
					
					await users.updateOne({ _id: user1._id }, { $set: { used: 0, settings: { enableSync: false } } });

					let files = await env.BUCKET.list({ prefix: env.FILE_PREFIX + user1._id });

					let truncated = files.truncated;
					let cursor = truncated ? files.cursor : undefined;

					while(truncated){
						let next = await env.BUCKET.list({ prefix: env.FILE_PREFIX + user1._id, cursor: cursor });
						files.objects.push(...next.objects);

						truncated = next.truncated;
						cursor = next.cursor;
					}

					for(let file of files.objects){
						await env.BUCKET.delete(file.key);
					}

					return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
				default:
					return new Response('404 Not Found', { status: 404 });
			}
		} else
			return new Response('404 Not Found', { status: 404 });
	},
};
