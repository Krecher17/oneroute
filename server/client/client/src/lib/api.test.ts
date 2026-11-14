import { describe, expect, it } from 'vitest';
import { ApiError, KeyedError, NetworkError, toMsg } from './api';

describe('toMsg', () => {
  it('maps server codes to translation keys', () => {
    expect(toMsg(new ApiError(401, 'wrong_credentials', 'Wrong email or password.'))).toEqual({ key: 'server.wrong_credentials' });
  });
  it('reuses client messages for shared codes', () => {
    expect(toMsg(new ApiError(400, 'terms_required', 'x'))).toEqual({ key: 'err.consent' });
    expect(toMsg(new ApiError(400, 'password_short', 'x'))).toEqual({ key: 'err.passwordShort' });
  });
  it('keeps the server text when there is no code', () => {
    expect(toMsg(new ApiError(500, undefined, 'Boom'))).toEqual({ raw: 'Boom' });
  });
  it('treats network failures and keyed errors', () => {
    expect(toMsg(new NetworkError())).toEqual({ key: 'err.network' });
    expect(toMsg(new KeyedError('err.imageBig'))).toEqual({ key: 'err.imageBig', params: {} });
  });
  it('falls back to a generic message', () => {
    expect(toMsg(undefined)).toEqual({ key: 'err.generic' });
    expect(toMsg(new ApiError(500, undefined, ''))).toEqual({ key: 'err.generic' });
  });
});
