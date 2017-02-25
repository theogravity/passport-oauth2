# 1.6.0 (2017-02-24)

  * Updated `tokenParams(options)` ->  `tokenParams(options, authCode, req)`
  * Updated `authorizationParams(options)` -> `authorizationParams(options, req)`

# 1.5.1 (2017-02-24)

  * Fix bug where the return value of the auth URL defined as a function was not being used in a certain place (the orig oauth instance was being used instead)

# 1.5.0 (2017-02-24)

  * Allow a function to be defined for `authorizationURL` and `tokenURL`
  * The profile callback function, `userProfile()`, now takes in the results of the access token call in the 3rd parameter

