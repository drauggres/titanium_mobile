/*
 * Appcelerator Titanium Mobile
 * Copyright (c) 2011-Present by Appcelerator, Inc. All Rights Reserved.
 * Licensed under the terms of the Apache Public License
 * Please see the LICENSE included with this distribution for details.
 */
/* eslint-env mocha */
/* eslint no-unused-expressions: "off" */
'use strict';
var should = require('./utilities/assertions');

describe('Transpilation', function () {
	it('Should pass', function () {
		let a = {b: [1, 2, 3]};
        let r = 0;
        let test = function test() {
            if (!a) {
                return;
            }
            const b = a.b;
            for (let i = 0, l = b.length; i < l; i++) {
                r += b[i];
            }
        };
        test();
        should(r).equal(6);
	});
});
