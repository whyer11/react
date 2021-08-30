const a = new Promise((resolve, reject) => {

})
a.then((resolve, reject) => {

}).catch(() => {

})

class MyPromise {
    callback = [];

    constructor(excutor: (resolve, reject) => void) {

        typeof excutor === "function" && excutor(this.resolve,this.reject);
    }

    resolve() {
    }

    reject() {
    }

    then(onFilled, onReject) {
        this.callback.push(onFilled);
    }
}