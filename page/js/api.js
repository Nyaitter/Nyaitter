export async function apiRequest(path, { method = 'GET', body } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    try {
        const response = await fetch(path, {
            method,
            headers,
            credentials: 'same-origin',
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok)
            return {
                data: null,
                error: new Error(
                    payload.error ||
                        payload.message ||
                        `HTTP ${response.status}`,
                ),
            };
        return { data: payload, error: null };
    } catch (error) {
        return { data: null, error };
    }
}

export const api = (() => {
    const unwrap = (result, key) => ({
        data: key ? result.data?.[key] : result.data,
        error: result.error,
    });
    const request = async (path, options, key) =>
        unwrap(await apiRequest(path, options), key);
    const query = (table) => {
        const state = {
            filters: [],
            action: 'select',
            values: null,
            single: false,
            limit: null,
        };
        const chain = {
            // Nyaitter RESTクエリファサードでは、update()/insert()後のselect()は返却形式の指定であり操作種別を上書きしない。

            select() {
                return chain;
            },
            update(values) {
                state.action = 'update';
                state.values = values;
                return chain;
            },
            insert(values) {
                state.action = 'insert';
                state.values = values;
                return chain;
            },
            delete() {
                state.action = 'delete';
                return chain;
            },
            eq(column, value) {
                state.filters.push(['eq', column, value]);
                return chain;
            },
            neq(column, value) {
                state.filters.push(['neq', column, value]);
                return chain;
            },
            in(column, value) {
                state.filters.push(['in', column, value]);
                return chain;
            },
            contains(column, value) {
                state.filters.push(['contains', column, value]);
                return chain;
            },
            or(value) {
                state.filters.push(['or', '', value]);
                return chain;
            },
            is(column, value) {
                state.filters.push(['is', column, value]);
                return chain;
            },
            order() {
                return chain;
            },
            range(from, to) {
                const start = Number(from);
                const end = Number(to);
                if (Number.isInteger(start) && start >= 0) {
                    state.range = {
                        from: start,
                        to:
                            Number.isInteger(end) && end >= start
                                ? end
                                : start,
                    };
                }
                return chain;
            },
            not() {
                return chain;
            },
            limit(value) {
                state.limit = value;
                return chain;
            },
            single() {
                state.single = true;
                return chain;
            },
            then(resolve, reject) {
                return execute().then(resolve, reject);
            },
        };
        const filter = (name, op) =>
            state.filters.find(
                (f) => f[1] === name && (!op || f[0] === op),
            )?.[2];
        async function execute() {
            const id = filter('id', 'eq');
            if (table === 'user') {
                if (state.action === 'update')
                    return request(
                        `/server/api/users/${id || 'me'}`,
                        { method: 'PUT', body: state.values },
                        'user',
                    );
                const inIds = filter('id', 'in');
                if (inIds)
                    return request(
                        `/server/api/users?ids=${inIds.join(',')}`,
                        {},
                        'users',
                    );
                if (id || filter('uuid', 'eq'))
                    return request(
                        id ? `/server/api/users/${id}` : '/server/auth/me',
                        {},
                        id ? 'user' : 'user',
                    );
                const rawFilter =
                    state.filters.find((f) => f[0] === 'or')?.[2] || '';
                const entries = rawFilter.split(',');
                const nameFilter = entries.find((entry) =>
                    entry.startsWith('name.ilike.'),
                );
                const idFilter = entries.find((entry) =>
                    /^id\.eq\.\d+$/.test(entry),
                );
                const query = nameFilter
                    ? nameFilter.replace(/.*ilike\.%|%.*/g, '')
                    : idFilter
                      ? `#${idFilter.slice('id.eq.'.length)}`
                      : '';
                const searchParams = new URLSearchParams();
                if (query) searchParams.set('q', query);
                if (state.range) {
                    searchParams.set(
                        'limit',
                        String(state.range.to - state.range.from + 1),
                    );
                    searchParams.set('offset', String(state.range.from));
                } else if (state.limit != null) {
                    searchParams.set('limit', String(state.limit));
                }
                const path = query
                    ? `search?${searchParams.toString()}`
                    : 'recommended';
                return request(`/server/api/users/${path}`, {}, 'users');
            }
            if (
                table === 'post' ||
                table === 'post_recent' ||
                table === 'post_profile'
            ) {
                if (state.action === 'update')
                    return request(
                        `/server/api/posts/${id}`,
                        { method: 'PUT', body: state.values },
                        'post',
                    );
                if (state.action === 'delete')
                    return request(`/server/api/posts/${id}`, {
                        method: 'DELETE',
                    });
                if (id) return request(`/server/api/posts/${id}`, {}, 'post');
                const userId = filter('userid') || filter('userId');
                return request(
                    userId
                        ? `/server/api/users/${userId}/posts?limit=${state.limit || 30}`
                        : `/server/api/posts?limit=${state.limit || 30}`,
                    {},
                    'posts',
                );
            }
            if (table === 'dm') {
                if (state.action === 'insert')
                    return request(
                        '/server/api/dm',
                        { method: 'POST', body: state.values },
                        'dm',
                    );
                if (state.action === 'update')
                    return request(
                        `/server/api/dm/${id}`,
                        { method: 'PUT', body: state.values },
                        'dm',
                    );
                if (state.action === 'delete')
                    return request(`/server/api/dm/${id}`, {
                        method: 'DELETE',
                    });
                return request(
                    id ? `/server/api/dm/${id}` : '/server/api/dm',
                    {},
                    'dm',
                );
            }
            return {
                data: null,
                error: new Error(`Unsupported Nyaitter resource: ${table}`),
            };
        }
        return chain;
    };
    const rpcRoutes = {
        get_all_unread_dm_counts: () => [
            '/server/api/dm/unread-counts',
            'counts',
        ],
        get_trending_hashtags: () => [
            '/server/api/posts/trending-hashtags',
            'trends',
        ],
        get_hydrated_posts: () => ['/server/api/posts/hydrate', 'posts'],
        get_all_replies: (p) => [
            `/server/api/posts/${p.root_post_id}/replies`,
            'replies',
        ],
        get_post_metrics: () => ['/server/api/posts/metrics', 'metrics'],
    };
    const withSingle = (promise) => {
        promise.single = async () => {
            const result = await promise;
            return {
                ...result,
                data: Array.isArray(result.data)
                    ? result.data[0] || null
                    : result.data,
            };
        };
        return promise;
    };
    const mapResponse = (promise, mapper) =>
        withSingle(
            promise.then(({ data, error }) => ({
                data: error ? null : mapper(data),
                error,
            })),
        );
    return {
        from: query,
        rpc(name, params = {}) {
            if (name === 'get_hydrated_posts')
                return withSingle(
                    request(
                        '/server/api/posts/hydrate',
                        {
                            method: 'POST',
                            body: {
                                post_ids:
                                    params.p_post_ids || params.post_ids || [],
                            },
                        },
                        'posts',
                    ),
                );
            if (name === 'get_post_metrics')
                return withSingle(
                    request(
                        '/server/api/posts/metrics',
                        {
                            method: 'POST',
                            body: { post_ids: params.post_ids || [] },
                        },
                        'metrics',
                    ),
                );
            if (name === 'is_lock')
                return mapResponse(
                    request(
                        `/server/api/users/${params.target_user_id}/is-lock`,
                    ),
                    (data) => data.lock,
                );
            if (name === 'get_status')
                return mapResponse(
                    request(`/server/api/users/${params.p_id}/status`),
                    (data) => data.status,
                );
            if (name === 'get_logs_with_masked_ip')
                return mapResponse(
                    request(
                        `/server/api/users/logs?limit=${params.p_limit || 30}&offset=${params.p_offset || 0}`,
                    ),
                    (data) => data.logs || [],
                );
            if (name === 'handle_pin')
                return mapResponse(
                    request(`/server/api/posts/${params.p_post_id}/pin`, {
                        method: 'POST',
                    }),
                    (data) => data.pin_id,
                );
            if (
                [
                    'get_user_post_count',
                    'get_user_media_count',
                    'get_follower_count',
                ].includes(name)
            ) {
                const userId = params.p_user_id || params.target_user_id;
                const key =
                    name === 'get_user_post_count'
                        ? 'post_count'
                        : name === 'get_user_media_count'
                          ? 'media_count'
                          : 'follower_count';
                return mapResponse(
                    request(`/server/api/users/${userId}/counts`),
                    (data) => data[key],
                );
            }
            if (name === 'create_post_new')
                return withSingle(
                    request(
                        '/server/api/posts',
                        {
                            method: 'POST',
                            body: {
                                content: params.p_content,
                                reply_to: params.p_reply_id,
                                repost_to: params.p_repost_to,
                                attachments: params.p_attachments || [],
                                mask: params.p_mask,
                                lock: params.p_lock,
                                announcement: params.p_announcement,
                            },
                        },
                        'post',
                    ),
                );

            if (name === 'handle_like')
                return withSingle(
                    request(
                        `/server/api/posts/${params.p_post_id || params.post_id_in}/like`,
                        { method: 'POST' },
                    ),
                );
            if (name === 'handle_star')
                return withSingle(
                    request(
                        `/server/api/posts/${params.p_post_id || params.post_id_in}/star`,
                        { method: 'POST' },
                    ),
                );
            if (name === 'handle_follow') {
                const targetUserId =
                    params.p_target_id ?? params.target_user_id;
                return withSingle(
                    request(
                        `/server/api/users/${encodeURIComponent(targetUserId)}/follow`,
                        { method: 'POST' },
                    ),
                );
            }
            if (name === 'append_to_dm_post')
                return withSingle(
                    request(
                        `/server/api/dm/${params.dm_id_in}/messages`,
                        {
                            method: 'POST',
                            body: { message: params.new_message_in },
                        },
                        'dm',
                    ),
                );
            if (name === 'mark_all_dm_messages_as_read')
                return withSingle(
                    request(`/server/api/dm/${params.dm_id_in}/read`, {
                        method: 'POST',
                    }),
                );
            if (name === 'leave_dm')
                return withSingle(
                    request(`/server/api/dm/${params.dm_id_in}/leave`, {
                        method: 'POST',
                    }),
                );
            if (name === 'mark_all_notifications_as_read')
                return withSingle(
                    request('/server/api/notifications/read-all', {
                        method: 'PUT',
                    }),
                );
            if (name === 'mark_all_notifications_as_clicked')
                return withSingle(
                    request('/server/api/notifications/click-all', {
                        method: 'PUT',
                    }),
                );
            if (name === 'mark_notification_as_read')
                return withSingle(
                    request(
                        `/server/api/notifications/${params.notification_id_to_update}/read`,
                        { method: 'PUT' },
                    ),
                );
            if (name === 'mark_notification_as_clicked')
                return withSingle(
                    request(
                        `/server/api/notifications/${params.notification_id_to_update}/clicked`,
                        { method: 'PUT' },
                    ),
                );
            if (name === 'delete_notification')
                return withSingle(
                    request(
                        `/server/api/notifications/${params.notification_id_to_delete}`,
                        { method: 'DELETE' },
                    ),
                );
            if (name === 'send_notification_with_timestamp')
                return withSingle(
                    request('/server/api/notifications', {
                        method: 'POST',
                        body: {
                            recipient_id: params.recipient_id,
                            type: params.type,
                            target: params.target,
                        },
                    }),
                );
            if (name === 'admin_set_status')
                return withSingle(
                    request(`/server/api/users/${params.p_id}/status`, {
                        method: 'PUT',
                        body: { shadow: params.p_shadow },
                    }),
                );
            const route = rpcRoutes[name];
            if (!route)
                return Promise.resolve({
                    data: null,
                    error: new Error(`Unsupported Nyaitter operation: ${name}`),
                });
            const [path, key] = route(params);
            return withSingle(
                request(
                    path,
                    {
                        method: [
                            'get_hydrated_posts',
                            'get_post_metrics',
                        ].includes(name)
                            ? 'POST'
                            : 'GET',
                        body: [
                            'get_hydrated_posts',
                            'get_post_metrics',
                        ].includes(name)
                            ? params
                            : undefined,
                    },
                    key,
                ),
            );
        },
        storage: {
            from: () => ({
                getPublicUrl: (id) => ({
                    data: { publicUrl: `/uploads/${encodeURIComponent(id)}` },
                }),
            }),
        },
        functions: {
            invoke: async (name, { body }) => {
                if (name === 'delete-files')
                    return apiRequest('/server/api/posts/uploads', {
                        method: 'DELETE',
                        body:
                            typeof body === 'string' ? JSON.parse(body) : body,
                    });
                return {
                    data: null,
                    error: new Error('Use the Nyaitter upload endpoint'),
                };
            },
        },
        auth: {
            // CookieはHttpOnlyのため、存在確認は認証済みの/me応答で行う。
            async getSession() {
                const result = await request('/server/auth/me', {}, 'user');
                return {
                    data: {
                        session: result.error ? null : { user: result.data },
                    },
                    error: result.error,
                };
            },
            async signOut() {
                return request('/server/auth/logout', { method: 'POST' });
            },
        },
        removeChannel() {},
        channel: () => ({
            on() {
                return this;
            },
            subscribe() {
                return this;
            },
        }),
    };
})();
