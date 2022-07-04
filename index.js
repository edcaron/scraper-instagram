'use strict';

/*
Modules
 */

const
	axios = require('axios').default,
	insta = 'https://www.instagram.com/';

/*
Utils
 */

const querystring = object => Object.keys(object).map(key => `${key}=${object[key]}`).join('&');

/*
Class private methods
 */

const self = {
	get: (path, sessionId, tryParse = true, params) => new Promise((resolve, reject) => {
		params = JSON.stringify({ __a: sessionId ? '1' : undefined, ...params });
		const url = insta + path + ((params !== '{}') ? ('/?' + querystring(JSON.parse(params))) : (tryParse ? '/' : ''));
		axios.get(url, {
			headers: {
				cookie: sessionId ? `sessionid=${sessionId}` : '',
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/103.0.0.0 Safari/537.36'
			},
			// maxRedirects: 1000,
			withCredentials: true,
			beforeRedirect: (options, { headers }) => {
				console.log('redirectou!');
				if (headers['set-cookie']) {
					for (let index = 0; index < headers['set-cookie'].length; index++) {
						const element = headers['set-cookie'][index].split(';');
						options.headers.cookie += (';' + element[0]);
					}
				}
			},
		}).then(res => {
			// console.log(res);
			let body = '';
			if (res.data) {
				return resolve(res.data);
			}
			else if (res.status !== 200) {
				switch (res.statusCode) {
					case 302: {
						switch (res.headers.location) {
							case insta + 'accounts/login/':
								return reject(429);
							case insta + 'accounts/login/?next=/accounts/edit/%3F__a%3D1':
								return reject(401);
							default: {
								if (res.headers.location.startsWith(insta + 'challenge/?next='))
									return reject(409);
								reject(res.statusCode);
							}
						}
						break;
					}
					default: reject(res.statusCode);
				}
			}
			else if (tryParse) {
				try {
					resolve(Object.values(JSON.parse(body)['graphql'] || JSON.parse(body))[0]);
				}
				catch (_) {
					try {
						resolve(Object.values(Object.values(JSON.parse(body.match(/_sharedData = (.+);/)[1])['entry_data'])[0][0]['graphql'])[0]);
					}
					catch (_) {
						reject(406);
					}
				}
			}
			return body;
		});
	}),
	search: (query, sessionId) => new Promise((resolve, reject) => self.get('web/search/topsearch', sessionId, false, { context: 'blended', query })
		.then(body => resolve(JSON.parse(body)))
		.catch(reject)),
	graphQL: (query, queryHash, sessionId) => self.get('graphql/query', sessionId, undefined, {
		query_hash: queryHash,
		variables: query ? JSON.stringify(query) : undefined
	}),
	partialPost: post => ({
		shortcode: post['node']['shortcode'],
		caption: post['node']['edge_media_to_caption']['edges'].length > 0
			? post['node']['edge_media_to_caption']['edges'][0]['node']['text'] : null,
		comments: post['node']['edge_media_to_comment']['count'],
		likes: post['node']['edge_liked_by']['count'],
		thumbnail: post['node']['display_url'],
		timestamp: post['node']['taken_at_timestamp']
	}),
	hashtagsRegex: /(?<=[\s>])#(\d*[A-Za-z_]+\d*)\b(?!;)/g,
	usernamesRegex: /@([A-Za-z0-9_](?:(?:[A-Za-z0-9_]|(?:\\.(?!\\.))){0,28}(?:[A-Za-z0-9_]))?)/g,
	postComment: comment => ({
		id: comment['node']['id'],
		user: comment['node']['owner']['username'],
		content: comment['node']['text'],
		timestamp: comment['node']['created_at'],
		hashtags: comment['node']['text'].match(self.hashtagsRegex),
		mentions: comment['node']['text'].match(self.usernamesRegex),
		likes: comment['node']['edge_liked_by']['count']
	}),
	fullPost: postParam => {
		const post = postParam[0];
		const
			caption = post['caption'] ? post['caption']['text'] : null,
			shortcode = post['code'],
			username = post['user']['username'];
		return {
			shortcode,
			author: {
				id: post['user']['pk'],
				username,
				name: post['user']['full_name'],
				pic: post['user']['profile_pic_url'],
				verified: post['user']['is_verified'],
				link: `${insta}/${username}`
			},
			location: post['location'] ? {
				id: post['location']['pk'],
				name: post['location']['name'],
				...(post['location']['address_json'] ? {
					city: JSON.parse(post['location']['address_json'])['city_name']
				} : {})
			} : null,
			...(self.getPostContent(post)),
			...(post['usertags'] ? {
				tagged: post['usertags']['in']
					.map(u => u['user']['pk'])
			} : {}),
			likes: post['like_count'],
			caption,
			hashtags: caption ? caption.match(self.hashtagsRegex) : null,
			mentions: caption ? caption.match(self.usernamesRegex) : null,
			edited: post['caption_is_edited'] || false,
			...(post['edge_media_preview_comment'] ? {
				comments: post['comments_disabled'] ? null : post['edge_media_preview_comment']['edges'].map(self.postComment),
				commentCount: post['edge_media_preview_comment']['count']
			} : {}),
			timestamp: post['taken_at'],
			link: insta + 'p/' + shortcode
		}
	},
	getPostContent: (post, recursive = false) => {
		let contents = {};
		if (typeof post['video_codec'] === 'undefined' && typeof post['carousel_media_count'] === 'undefined') {
			contents = self.getImagePost(post);
		} else if (typeof post['video_codec'] !== 'undefined' && typeof post['carousel_media_count'] === 'undefined') {
			contents = self.getVideoPost(post);
		} else if (typeof post['carousel_media'] !== 'undefined') {
			return {
				contents:
					post['carousel_media'].map(content => {
						return self.getPostContent(content, true);
					})
			};
		}
		return recursive ? contents : { 'contents': [contents] };
	},
	getImagePost: post => {
		const best = self.getBestMedia(post['image_versions2']['candidates'], post['original_width'], post['original_height']);
		return {
			type: 'photo',
			url: best['url']
		};
	},
	getVideoPost: post => {
		const best = self.getBestMedia(post['video_versions'], post['original_width'], post['original_height']);

		return {
			type: 'video',
			url: best['url'],
			thumbnail: post['image_versions2']['candidates'][0]['url'],
			views: post['view_count']
		};
	},
	getBestMedia: (posts, original_width, original_height) => {
		return posts.find((el) => {
			return el.width == original_width && el.height == original_height;
		}) ?? posts[0];
	}
};

/*
Memoization
 */
const profileIds = {};

/*
Class public properties & methods
 */

module.exports = class Insta {
	constructor() {
		this.sessionId = undefined;
		this.username = undefined;
		this.queryHashs = {};
	}
	authBySessionId(sessionId) {
		return new Promise((resolve, reject) => self.get('accounts/edit', sessionId, true, { '__d': 'dis' })
			.then(body => {
				if (this.sessionId)
					process.emitWarning('Session ID changed');
				this.sessionId = sessionId;
				this.username = body['username'];
				resolve(body);
			})
			.catch(reject));
	}
	getAccountNotifications() {
		return new Promise((resolve, reject) => {
			if (!this.sessionId) return reject(401);
			self.get('accounts/activity', this.sessionId).then(res => {
				resolve(res['activity_feed']['edge_web_activity_feed']['edges'].map(item => item['node']).map(notification => ({
					id: notification['id'],
					timestamp: notification['timestamp'],
					type: ({
						'GraphLikeAggregatedStory': 'like',
						'GraphMentionStory': 'mention',
						'GraphCommentMediaStory': 'comment',
						'GraphFollowAggregatedStory': 'follow'
					})[notification['__typename']],
					...(notification['media'] ? {
						post: {
							shortcode: notification['media']['shortcode'],
							thumbnail: notification['media']['thumbnail_src']
						}
					} : {}),
					...(notification['user'] ? {
						by: {
							username: notification['user']['username'],
							name: notification['user']['full_name'],
							pic: notification['user']['profile_pic_url']
						}
					} : {}),
					...(notification['__typename'] === 'GraphMentionStory' ? {
						content: notification['text']
					} : {})
				})));
			}).catch(reject);
		});
	}
	getAccountStories() {
		return new Promise((resolve, reject) => {
			if (!this.sessionId) return reject(401);
			self.get('', this.sessionId, false, { __a: undefined }).then(body => {
				self.graphQL(
					undefined,
					body.match(/<link rel="preload" href="\/graphql\/query\/\?query_hash=(.+)&amp;/)[1],
					this.sessionId
				).then(body => {
					resolve(body['user']['feed_reels_tray']['edge_reels_tray_to_reel']['edges'].map(item => ({
						unread: item['node']['latest_reel_media'] !== item['node']['seen'],
						author: {
							id: item['node']['user']['id'],
							username: item['node']['user']['username'],
							pic: item['node']['user']['profile_pic_url']
						},
						user: {
							requesting: item['node']['user']['requested_by_viewer'],
							following: item['node']['user']['followed_by_viewer']
						}
					})));
				}).catch(reject);
			}).catch(reject);
		});
	}
	getProfile(username = this.username, anonymous = false) {
		return new Promise((resolve, reject) => self.get(username, anonymous ? null : this.sessionId)
			.then(profile => {
				const
					id = profile['id'],
					access = !profile['is_private'] || !!profile['followed_by_viewer'] || profile['username'] === this.username;
				profileIds[username] = id;
				resolve({
					id,
					name: profile['full_name'],
					pic: profile['profile_pic_url_hd'],
					bio: profile['biography'],
					private: profile['is_private'],
					access,
					verified: profile['is_verified'],
					website: profile['external_url'],
					followers: profile['edge_followed_by']['count'],
					following: profile['edge_follow']['count'],
					posts: profile['edge_owner_to_timeline_media']['count'],
					lastPosts: access ? profile['edge_owner_to_timeline_media']['edges'].map(post => self.partialPost(post)) : null,
					link: insta + profile['username'],
					...(profile['is_business_account'] ? {
						business: profile['business_category_name']
					} : {}),
					...(this.sessionId ? {
						user: {
							mutualFollowers: profile['edge_mutual_followed_by']['edges'].map(item => item['node']['username']),
							blocking: profile['blocked_by_viewer'],
							blocked: profile['has_blocked_viewer'],
							requesting: profile['requested_by_viewer'],
							requested: profile['has_requested_viewer'],
							following: profile['followed_by_viewer'],
							followed: profile['follows_viewer']
						}
					} : {})
				});
			})
			.catch(err => {
				if (err === 204) {
					this.getProfile(username, true)
						.then(profile => resolve(Object.assign(profile, {
							user: { blocked: true }
						})))
						.catch(reject);
				}
				else
					reject(err);
			}));
	}
	async _getProfileId(username) {
		if (!profileIds[username])
			profileIds[username] = (await this.getProfile(username)).id;
		return profileIds[username];
	}
	async _getQueryHashs() {
		if (JSON.stringify(this.queryHashs) !== '{}') return this.queryHashs;
		const
			{
				Consumer,
				TagPageContainer,
				LocationPageContainer
			} = Object.fromEntries([
				...(await self.get('', this.sessionId, false, { __a: undefined }))
					.matchAll(/static\/bundles\/.+?\/(.+?)\.js\/.+?\.js/g)
			].map(_ => _.reverse())),
			mainScriptBody = await self.get(Consumer, undefined, false),
			hashtagScriptBody = await self.get(TagPageContainer, undefined, false),
			locationScriptBody = await self.get(LocationPageContainer, undefined, false),
			localQueryIdRegex = /queryId:"([^"]+)"/;
		const [
			,
			[, comment],
			,
			[, post]
		] = [...mainScriptBody.matchAll(/queryId:"([^"]+)"/g)];
		this.queryHashs = {
			story: mainScriptBody.match(/50,[a-zA-Z]="([^"]+)",/)[1],
			post,
			comment,
			hashtag: hashtagScriptBody.match(localQueryIdRegex)[1],
			location: locationScriptBody.match(localQueryIdRegex)[1]
		};
		return this.queryHashs;
	}
	getProfileStoryById(id) {
		return new Promise((resolve, reject) => {
			if (!this.sessionId) return reject(401);
			this._getQueryHashs().then(queryHashs => self.graphQL({
				reel_ids: [id],
				precomposed_overlay: false
			}, queryHashs.story, this.sessionId).then(data => resolve(data['reels_media'][0] ? {
				unread: data['reels_media'][0]['latest_reel_media'] !== data['reels_media'][0]['seen'],
				author: {
					username: data['reels_media'][0]['user']['username'],
					pic: data['reels_media'][0]['user']['profile_pic_url']
				},
				user: {
					requesting: data['reels_media'][0]['user']['requested_by_viewer'],
					following: data['reels_media'][0]['user']['followed_by_viewer']
				},
				items: data['reels_media'][0]['items'].map(item => ({
					url: item['is_video'] ? item['video_resources'][0]['src'] : item['display_url'],
					type: item['is_video'] ? 'video' : 'photo',
					timestamp: item['taken_at_timestamp'],
					expirationTimestamp: item['expiring_at_timestamp'],
					...(item['story_cta_url'] ? {
						externalLink: item['story_cta_url']
					} : {})
				}))
			} : null)).catch(reject)).catch(reject);
		});
	}
	getProfileStory(username = this.username) {
		return new Promise((resolve, reject) => {
			this._getProfileId(username)
				.then(id =>
					this.getProfileStoryById(id)
						.then(resolve)
						.catch(reject))
				.catch(reject);
		});
	}
	async getProfilePostsById(profileId, maxCount, pageId) {
		const res = await self.graphQL({
			id: profileId,
			first: maxCount,
			after: pageId
		}, (await this._getQueryHashs()).post, this.sessionId);
		return Object.assign(
			res['user']['edge_owner_to_timeline_media']['edges'].map(item => self.fullPost(item['node'])),
			{
				nextPageId: res['user']['edge_owner_to_timeline_media']['page_info']['has_next_page']
					? res['user']['edge_owner_to_timeline_media']['page_info']['end_cursor']
					: undefined
			}
		);
	}
	async getProfilePosts(profileUsername, maxCount, pageId) {
		return this.getProfilePostsById(await this._getProfileId(profileUsername), maxCount, pageId);
	}
	getHashtag(hashtag) {
		return new Promise((resolve, reject) => {
			const path = `explore/tags/${hashtag}`;
			self.get(path, this.sessionId)
				.then(hashtag => resolve({
					pic: hashtag['profile_pic_url'],
					posts: hashtag['edge_hashtag_to_media']['count'],
					featuredPosts: hashtag['edge_hashtag_to_top_posts']['edges'].map(post => self.partialPost(post)),
					lastPosts: hashtag['edge_hashtag_to_media']['edges'].map(post => self.partialPost(post)),
					link: insta + path,
					...(this.sessionId ? {
						user: {
							following: hashtag['is_following']
						}
					} : {})
				}))
				.catch(reject);
		});
	}
	async getHashtagPosts(hashtag, maxCount, pageId) {
		const res = await self.graphQL({
			tag_name: hashtag,
			first: maxCount,
			after: pageId
		}, (await this._getQueryHashs()).hashtag, this.sessionId);
		return Object.assign(
			res['hashtag']['edge_hashtag_to_media']['edges'].map(post => self.partialPost(post)),
			{
				nextPageId: res['hashtag']['edge_hashtag_to_media']['page_info']['has_next_page']
					? res['hashtag']['edge_hashtag_to_media']['page_info']['end_cursor']
					: undefined
			}
		);
	}
	getLocation(id) {
		return new Promise((resolve, reject) => {
			const path = `explore/locations/${id}`;
			self.get(path)
				.then(location => {
					const address = JSON.parse(location['address_json']);
					resolve({
						pic: location['profile_pic_url'],
						posts: location['edge_location_to_media']['count'],
						address: {
							street: address['street_address'],
							zipCode: address['zip_code'],
							city: address['city_name'],
							latitude: location['lat'],
							longitude: location['lng']
						},
						website: location['website'],
						phone: location['phone'],
						featuredPosts: location['edge_location_to_top_posts']['edges'].map(post => self.partialPost(post)),
						lastPosts: location['edge_location_to_media']['edges'].map(post => self.partialPost(post)),
						link: insta + path
					});
				})
				.catch(reject);
		});
	}
	async getLocationPostsById(locationId, maxCount, pageId) {
		const res = await self.graphQL({
			id: locationId,
			first: maxCount,
			after: pageId
		}, (await this._getQueryHashs()).location, this.sessionId);
		return Object.assign(
			res['location']['edge_location_to_media']['edges'].map(post => self.partialPost(post)),
			{
				nextPageId: res['location']['edge_location_to_media']['page_info']['has_next_page']
					? res['location']['edge_location_to_media']['page_info']['end_cursor']
					: undefined
			}
		);
	}
	getPost(shortcode) {
		return new Promise((resolve, reject) => {
			self.get(`p/${shortcode}`, this.sessionId)
				.then(post => resolve(self.fullPost(post)))
				.catch(reject);
		});
	}
	async getPostComments(shortcode, maxCount, pageId) {
		const res = await self.graphQL({
			shortcode,
			first: maxCount,
			after: pageId
		}, (await this._getQueryHashs()).comment, this.sessionId);
		return Object.assign(
			res['shortcode_media']['edge_media_to_parent_comment']['edges'].map(self.postComment),
			{
				nextPageId: res['shortcode_media']['edge_media_to_parent_comment']['page_info']['has_next_page']
					? res['shortcode_media']['edge_media_to_parent_comment']['page_info']['end_cursor']
					: undefined
			}
		);
	}
	searchProfile(query) {
		return new Promise((resolve, reject) => self.search(query, this.sessionId)
			.then(res => resolve(res['users'].map(item => item['user']).map(profile => ({
				username: profile['username'],
				name: profile['full_name'],
				pic: profile['profile_pic_url'],
				private: profile['is_private'],
				verified: profile['is_verified'],
				followers: profile['follower_count'],
				...(this.sessionId ? {
					user: {
						following: profile['following']
					}
				} : {})
			}))))
			.catch(reject));
	}
	searchHashtag(query) {
		return new Promise((resolve, reject) => self.search(query)
			.then(res => resolve(res['hashtags'].map(item => item['hashtag'])
				.map(hashtag => ({ name: hashtag['name'], posts: hashtag['media_count'] }))))
			.catch(reject));
	}
	searchLocation(query) {
		return new Promise((resolve, reject) => self.search(query)
			.then(res => resolve(res['places'].map(item => item['place']['location']).map(location => ({
				id: location['pk'],
				name: location['name'],
				address: {
					street: location['address'],
					city: location['city'],
					latitude: location['lat'],
					longitude: location['lng']
				}
			}))))
			.catch(reject));
	}
	subscribeAccountNotifications(callback, {
		interval = 30,
		lastNotificationId
	}) {
		let active = true;
		const checkNewNotifications = () => {
			if (!active) return;
			(async () => {
				try {
					const notifications = await this.getAccountNotifications();
					const lastNotificationIndex = notifications.findIndex(notification => notification.id === lastNotificationId);
					if (lastNotificationIndex !== -1) {
						for (let i = lastNotificationIndex - 1; i > -1; i--) {
							callback(notifications[i]);
						}
					}
					lastNotificationId = notifications[0].id;
					setTimeout(checkNewNotifications, interval * 1000);
				}
				catch (err) {
					callback(undefined, err);
					checkNewNotifications();
				}
			})();
		};
		checkNewNotifications();
		return {
			unsubscribe: () => {
				active = false;
			}
		};
	}
	subscribeUserPosts(username, callback, {
		interval = 30,
		lastPostShortcode,
		fullPosts = false
	} = {}) {
		let active = true;
		const checkNewPosts = () => {
			if (!active) return;
			(async () => {
				try {
					const profile = await this.getProfile(username);
					const lastPostIndex = profile.lastPosts.findIndex(post => post.shortcode === lastPostShortcode);
					if (lastPostIndex !== -1) {
						for (let i = lastPostIndex - 1; i > -1; i--) {
							callback(fullPosts ? (await this.getPost(profile.lastPosts[i].shortcode)) : profile.lastPosts[i]);
						}
					}
					lastPostShortcode = profile.lastPosts[0].shortcode;
					setTimeout(checkNewPosts, interval * 1000);
				}
				catch (err) {
					callback(undefined, err);
					checkNewPosts();
				}
			})();
		};
		checkNewPosts();
		return {
			unsubscribe: () => {
				active = false;
			}
		};
	}
	subscribeHashtagPosts(hashtagName, callback, {
		interval = 30,
		lastPostShortcode = undefined,
		fullPosts = false
	} = {}) {
		let active = true;
		const checkNewPosts = () => {
			if (!active) return;
			(async () => {
				try {
					const hashtag = await this.getHashtag(hashtagName);
					const lastPostIndex = hashtag.lastPosts.findIndex(post => post.shortcode === lastPostShortcode);
					for (let i = lastPostIndex - 1; i > -1; i--) {
						callback(fullPosts ? (await this.getPost(hashtag.lastPosts[i].shortcode)) : hashtag.lastPosts[i]);
					}
					lastPostShortcode = hashtag.lastPosts[0].shortcode;
					setTimeout(checkNewPosts, interval * 1000);
				}
				catch (err) {
					callback(undefined, err);
					checkNewPosts();
				}
			})();
		};
		checkNewPosts();
		return {
			unsubscribe: () => {
				active = false;
			}
		};
	}
};
