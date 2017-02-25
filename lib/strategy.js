// Load modules.
var passport = require('passport-strategy')
  , url = require('url')
  , util = require('util')
  , utils = require('./utils')
  , OAuth2 = require('oauth').OAuth2
  , NullStateStore = require('./state/null')
  , SessionStateStore = require('./state/session')
  , AuthorizationError = require('./errors/authorizationerror')
  , TokenError = require('./errors/tokenerror')
  , InternalOAuthError = require('./errors/internaloautherror');


/**
 * Creates an instance of `OAuth2Strategy`.
 *
 * The OAuth 2.0 authentication strategy authenticates requests using the OAuth
 * 2.0 framework.
 *
 * OAuth 2.0 provides a facility for delegated authentication, whereby users can
 * authenticate using a third-party service such as Facebook.  Delegating in
 * this manner involves a sequence of events, including redirecting the user to
 * the third-party service for authorization.  Once authorization has been
 * granted, the user is redirected back to the application and an authorization
 * code can be used to obtain credentials.
 *
 * Applications must supply a `verify` callback, for which the function
 * signature is:
 *
 *     function(accessToken, refreshToken, profile, done) { ... }
 *
 * The verify callback is responsible for finding or creating the user, and
 * invoking `done` with the following arguments:
 *
 *     done(err, user, info);
 *
 * `user` should be set to `false` to indicate an authentication failure.
 * Additional `info` can optionally be passed as a third argument, typically
 * used to display informational messages.  If an exception occured, `err`
 * should be set.
 *
 * Options:
 *
 *   - `authorizationURL`  URL used to obtain an authorization grant
 *   - `tokenURL`          URL used to obtain an access token
 *   - `clientID`          identifies client to service provider
 *   - `clientSecret`      secret used to establish ownership of the client identifer
 *   - `callbackURL`       URL to which the service provider will redirect the user after obtaining authorization
 *   - `passReqToCallback` when `true`, `req` is the first argument to the verify callback (default: `false`)
 *
 * Examples:
 *
 *     passport.use(new OAuth2Strategy({
 *         authorizationURL: 'https://www.example.com/oauth2/authorize',
 *         tokenURL: 'https://www.example.com/oauth2/token',
 *         clientID: '123-456-789',
 *         clientSecret: 'shhh-its-a-secret'
 *         callbackURL: 'https://www.example.net/auth/example/callback'
 *       },
 *       function(accessToken, refreshToken, profile, done) {
 *         User.findOrCreate(..., function (err, user) {
 *           done(err, user);
 *         });
 *       }
 *     ));
 *
 * @constructor
 * @param {Object} options
 * @param {Function} verify
 * @api public
 */
function OAuth2Strategy(options, verify) {
  if (typeof options == 'function') {
    verify = options;
    options = undefined;
  }
  options = options || {};

  if (!verify) { throw new TypeError('OAuth2Strategy requires a verify callback'); }
  if (!options.authorizationURL) { throw new TypeError('OAuth2Strategy requires a authorizationURL option'); }
  if (!options.tokenURL) { throw new TypeError('OAuth2Strategy requires a tokenURL option'); }
  if (!options.clientID) { throw new TypeError('OAuth2Strategy requires a clientID option'); }

  passport.Strategy.call(this);
  this.name = 'oauth2';
  this._verify = verify;
  this._oauth2 = null;
  this._key = null;
  this._stateStore = null;

  // create this once if none of the params are dynamic
  if (typeof options.authorizationURL !== 'function' && options.tokenURL !== 'function') {
    // NOTE: The _oauth2 property is considered "protected".  Subclasses are
    //       allowed to use it when making protected resource requests to retrieve
    //       the user profile.
    this._oauth2 = new OAuth2(options.clientID,  options.clientSecret,
      '', options.authorizationURL, options.tokenURL, options.customHeaders);

    this._key = options.sessionKey || ('oauth2:' + url.parse(options.authorizationURL).hostname);

    if (options.store) {
      this._stateStore = options.store;
    } else {
      if (options.state) {
        this._stateStore = new SessionStateStore({ key: this._key });
      } else {
        this._stateStore = new NullStateStore();
      }
    }
  }

  this._callbackURL = options.callbackURL;
  this._scope = options.scope;
  this._scopeSeparator = options.scopeSeparator || ' ';

  this._trustProxy = options.proxy;
  this._passReqToCallback = options.passReqToCallback;
  this._skipUserProfile = (options.skipUserProfile === undefined) ? false : options.skipUserProfile;

  this._options = options
}

// Inherit from `passport.Strategy`.
util.inherits(OAuth2Strategy, passport.Strategy);


/**
 * Authenticate request by delegating to a service provider using OAuth 2.0.
 *
 * @param {Object} req
 * @api protected
 */
OAuth2Strategy.prototype.authenticate = function(req, options) {
  options = options || {};
  var self = this;

  if (req.query && req.query.error) {
    if (req.query.error == 'access_denied') {
      return this.fail({ message: req.query.error_description });
    } else {
      return this.error(new AuthorizationError(req.query.error_description, req.query.error, req.query.error_uri));
    }
  }

  var callbackURL = options.callbackURL || this._callbackURL;
  if (callbackURL) {
    var parsed = url.parse(callbackURL);
    if (!parsed.protocol) {
      // The callback URL is relative, resolve a fully qualified URL from the
      // URL of the originating request.
      callbackURL = url.resolve(utils.originalURL(req, { proxy: this._trustProxy }), callbackURL);
    }
  }

  var authURL = this._options.authorizationURL;
  var tokenURL = this._options.tokenURL;
  var dynamicURLs = false
  var oauthInstance = self._oauth2
  var sessionKey = self._key

  if (typeof authURL === 'function') {
    authURL = authURL(req, options);
    dynamicURLs = true;
  }

  if (typeof tokenURL === 'function') {
    tokenURL = tokenURL(req, options);
    dynamicURLs = true;
  }

  if (dynamicURLs) {
    // re-create the oauth2 instance because a dynamic URL was used
    // potential perf issue as we're re-creating the instance
    oauthInstance = new OAuth2(self._options.clientID, self._options.clientSecret,
      '', authURL, tokenURL, self._options.customHeaders);

    sessionKey = self._options.sessionKey || ('oauth2:' + url.parse(authURL).hostname);

    if (!self._stateStore && !self._options.store) {
      if (self._options.state) {
        self._stateStore = new SessionStateStore({ key: sessionKey });
      } else {
        self._stateStore = new NullStateStore();
      }
    }
  }

  var meta = {
    authorizationURL: authURL,
    tokenURL: tokenURL,
    clientID: this._options.clientID
  };

  if (req.query && req.query.code) {
    function loaded(err, ok, state) {
      if (err) { return self.error(err); }
      if (!ok) {
        return self.fail(state, 403);
      }
  
      var code = self.transformAuthCode(req.query.code);

      var params = self.tokenParams(options, code, req);
      params.grant_type = 'authorization_code';
      if (callbackURL) { params.redirect_uri = callbackURL; }

      oauthInstance.getOAuthAccessToken(code, params,
        function(err, accessToken, refreshToken, results) {
          if (err) { return self.error(self._createOAuthError('Failed to obtain access token', err)); }

          self._loadUserProfile(accessToken, function(err, profile) {
            if (err) { return self.error(err); }

            function verified(err, user, info) {
              if (err) { return self.error(err); }
              if (!user) { return self.fail(info); }
              
              info = info || {};
              if (state) { info.state = state; }
              self.success(user, info);
            }

            try {
              if (self._passReqToCallback) {
                var arity = self._verify.length;
                if (arity == 6) {
                  self._verify(req, accessToken, refreshToken, results, profile, verified);
                } else { // arity == 5
                  self._verify(req, accessToken, refreshToken, profile, verified);
                }
              } else {
                var arity = self._verify.length;
                if (arity == 5) {
                  self._verify(accessToken, refreshToken, results, profile, verified);
                } else { // arity == 4
                  self._verify(accessToken, refreshToken, profile, verified);
                }
              }
            } catch (ex) {
              return self.error(ex);
            }
          }, results, req, oauthInstance);
        }
      );
    }
    
    var state = req.query.state;
    try {
      var arity = self._stateStore.verify.length;
      if (arity == 4) {
        self._stateStore.verify(req, state, meta, loaded);
      } else { // arity == 3
        self._stateStore.verify(req, state, loaded);
      }
    } catch (ex) {
      return self.error(ex);
    }
  } else {
    var params = self.authorizationParams(options, req);
    params.response_type = 'code';
    if (callbackURL) { params.redirect_uri = callbackURL; }
    var scope = options.scope || self._scope;
    if (scope) {
      if (Array.isArray(scope)) { scope = scope.join(self._scopeSeparator); }
      params.scope = scope;
    }

    var state = options.state;
    if (state) {
      params.state = state;
      
      var parsed = url.parse(oauthInstance._authorizeUrl, true);
      utils.merge(parsed.query, params);
      parsed.query['client_id'] = oauthInstance._clientId;
      delete parsed.search;
      var location = url.format(parsed);
      self.redirect(location);
    } else {
      function stored(err, state) {
        if (err) { return self.error(err); }

        if (state) { params.state = state; }
        var parsed = url.parse(oauthInstance._authorizeUrl, true);
        utils.merge(parsed.query, params);
        parsed.query['client_id'] = oauthInstance._clientId;
        delete parsed.search;
        var location = url.format(parsed);
        self.redirect(location);
      }
      
      try {
        var arity = self._stateStore.store.length;
        if (arity == 3) {
          self._stateStore.store(req, meta, stored);
        } else { // arity == 2
          self._stateStore.store(req, stored);
        }
      } catch (ex) {
        return self.error(ex);
      }
    }
  }
};

/**
 * Retrieve user profile from service provider.
 *
 * OAuth 2.0-based authentication strategies can overrride this function in
 * order to load the user's profile from the service provider.  This assists
 * applications (and users of those applications) in the initial registration
 * process by automatically submitting required information.
 *
 * @param {String} accessToken
 * @param {Function} done
 * @param {Object} tokenReqResults Response results from the access token call
 * @param {Object} req request object
 * @param {Object} oauthInstance The oauth instance used to make requests
 * @api protected
 */
OAuth2Strategy.prototype.userProfile = function(accessToken, done, tokenReqResults, req, oauthInstance) {
  return done(null, {});
};

/**
 * Return extra parameters to be included in the authorization request.
 *
 * Some OAuth 2.0 providers allow additional, non-standard parameters to be
 * included when requesting authorization.  Since these parameters are not
 * standardized by the OAuth 2.0 specification, OAuth 2.0-based authentication
 * strategies can overrride this function in order to populate these parameters
 * as required by the provider.
 *
 * @param {Object} options
 * @return {Object}
 * @api protected
 */
OAuth2Strategy.prototype.authorizationParams = function(options, req) {
  return {};
};

/**
 * Return extra parameters to be included in the token request.
 *
 * Some OAuth 2.0 providers allow additional, non-standard parameters to be
 * included when requesting an access token.  Since these parameters are not
 * standardized by the OAuth 2.0 specification, OAuth 2.0-based authentication
 * strategies can overrride this function in order to populate these parameters
 * as required by the provider.
 *
 * @return {Object}
 * @api protected
 */
OAuth2Strategy.prototype.tokenParams = function(options, authCode, req) {
  return {};
};

/**
 * Transforms the auth code if necessary.
 *
 * @param {String} code
 * @api protected
 */
OAuth2Strategy.prototype.transformAuthCode = function(code) {
  return code
};

/**
 * Parse error response from OAuth 2.0 endpoint.
 *
 * OAuth 2.0-based authentication strategies can overrride this function in
 * order to parse error responses received from the token endpoint, allowing the
 * most informative message to be displayed.
 *
 * If this function is not overridden, the body will be parsed in accordance
 * with RFC 6749, section 5.2.
 *
 * @param {String} body
 * @param {Number} status
 * @return {Error}
 * @api protected
 */
OAuth2Strategy.prototype.parseErrorResponse = function(body, status) {
  var json = JSON.parse(body);
  if (json.error) {
    return new TokenError(json.error_description, json.error, json.error_uri);
  }
  return null;
};



/**
 * Load user profile, contingent upon options.
 *
 * @param {String} accessToken
 * @param {Function} done
 * @param {Object} tokenReqResults Response results from the access token call
 * @param {Object} req request object
 * @param {Object} oauthInstance The oauth instance used to make requests
 * @api private
 */
OAuth2Strategy.prototype._loadUserProfile = function(accessToken, done, tokenReqResults, req, oauthInstance) {
  var self = this;

  function loadIt() {
    return self.userProfile(accessToken, done, tokenReqResults, req, oauthInstance);
  }
  function skipIt() {
    return done(null);
  }

  if (typeof this._skipUserProfile == 'function' && this._skipUserProfile.length > 1) {
    // async
    this._skipUserProfile(accessToken, function(err, skip) {
      if (err) { return done(err); }
      if (!skip) { return loadIt(); }
      return skipIt();
    });
  } else {
    var skip = (typeof this._skipUserProfile == 'function') ? this._skipUserProfile() : this._skipUserProfile;
    if (!skip) { return loadIt(); }
    return skipIt();
  }
};

/**
 * Create an OAuth error.
 *
 * @param {String} message
 * @param {Object|Error} err
 * @api private
 */
OAuth2Strategy.prototype._createOAuthError = function(message, err) {
  var e;
  if (err.statusCode && err.data) {
    try {
      e = this.parseErrorResponse(err.data, err.statusCode);
    } catch (_) {}
  }
  if (!e) { e = new InternalOAuthError(message, err); }
  return e;
};


// Expose constructor.
module.exports = OAuth2Strategy;
