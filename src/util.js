const request = require("request");

exports.UTIL = {
    getUnshortenedUrl: (args) => {
        return new Promise((resolve, reject) => {
            const { url } = args;
            request({uri: url, followRedirect: false}, function (err, httpResponse) {
                if (err) {
                    return reject(err);
                }
                resolve({url: httpResponse.headers.location || url});
            });
        });
    }
};