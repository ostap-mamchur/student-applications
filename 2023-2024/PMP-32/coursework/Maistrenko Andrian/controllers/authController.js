const User = require("./../models/userModel");
const Purchases = require("./../models/purchasingModel");
const Product = require("./../models/productModel");
const { promisify } = require("util");
const catchAsync = require("./../utils/catchAsync");
const jwt = require("jsonwebtoken");
const AppError = require("./../utils/appError");
const sendEmail = require("./../utils/email");
const { removeListener } = require("process");
const crypto = require("crypto");
const Email = require("./../utils/email");

const signToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN,
  });
};

const createSendToken = (user, statusCode, req, res) => {
  const token = signToken(user._id);

  res.cookie("jwt", token, {
    expires: new Date(
      Date.now() + process.env.JWT_COOKIE_EXPIRES_IN * 24 * 60 * 60 * 1000,
    ),
    httpOnly: true,
    secure: (req.secure || req.headers['x-forwarded-photo'] === 'https')
  });

  // remove the passport from the output
  user.password = undefined;

  res.status(statusCode).json({
    status: "success",
    token,
    data: {
      user,
    },
  });
};

exports.signup = catchAsync(async (req, res, next) => {
  const newUser = await User.create({
    name: req.body.name,
    email: req.body.email,
    password: req.body.password,
    passwordConfirm: req.body.passwordConfirm,
    passwordChangedAt: req.body.passwordChangedAt,
    role: req.body.role,
  });

  //const url=`${req.protocol}//:${req.get('host')}/me`;
  const url = `${req.get("host")}/me`;
  // console.log(url);
  await new Email(newUser, url).sendWelcome();

  createSendToken(newUser, 201, req, res);
});

exports.getStats = catchAsync(async (req,res,next) => {
  const email = req.body.email;
  showAlert(email);
  if(!email){
    return next(new AppError("Please provide email", 400));
  }
  const purchases = await Purchases.find({ user:req.user.id});
  //find products with ids from purchases
  const productIDs = purchases.map(el => el.product);
  // select all the products that are in the productsIDs
  const products = await Product.find({ _id: {$in: productIDs}});
  const prices = products.map(el => el.price);
  const totalPrice = prices.reduce((acc, curr) => acc + curr, 0);

  res.status(200).json({
    status: 'success',
    data:{
      products,
      totalPrice
    }
  })
});

exports.login = catchAsync(async (req, res, next) => {
  const { email, password } = req.body;
  // check if exists
  if (!email || !password) {
    return next(new AppError("Please provide email or password", 400));
  }
  // if user exists
  const user = await User.findOne({ email: email }).select("+password");

  if (!user || !(await user.correctPassword(password, user.password))) {
    return next(new AppError("Incorrect email or password", 401));
  }
  // send token if all good
  createSendToken(user, 200, req, res);
});

// only for render pages, no error
exports.isLoggedIn = async (req, res, next) => {
  try {
    if (req.cookies.jwt) {
      //1 verify token
      const decoded = await promisify(jwt.verify)(
        req.cookies.jwt,
        process.env.JWT_SECRET,
      );

      //2 if user still exists
      const freshUser = await User.findById(decoded.id);
      if (!freshUser) return next();

      //3 if user changed password after the token was issued
      if (freshUser.changedPasswordAfter(decoded.iat)) {
        return next();
      }

      // logged in if made it to this place
      res.locals.user = freshUser;
      return next();
    }
  } catch (err) {
    return next();
  }
  next();
};

exports.logout = (req, res) => {
  res.cookie("jwt", "loggedout", {
    expires: new Date(Date.now() + 10 * 1000),
    httpOnly: true,
  });

  res.status(200).json({ status: "success" });
};

exports.protect = catchAsync(async (req, res, next) => {
  let token;
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    token = req.headers.authorization.split(" ")[1];
  } else if (req.cookies.jwt) {
    token = req.cookies.jwt;
  } else if (req.cookies.jwt) {
    token = req.cookies.jwt;
  }

  if (!token) {
    return next(
      new AppError("You are not logged in, please login to get access", 401),
    );
  }

  //2 validate the token (verification)
  const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET);

  //3 if user still exists
  const freshUser = await User.findById(decoded.id);
  if (!freshUser)
    return next(
      new AppError("The user belonging to this token is no longer exist.", 401),
    );

  //4 if user changed password after the token was issued
  if (freshUser.changedPasswordAfter(decoded.iat)) {
    return next(
      new AppError("User recently changed password! Please log again", 401),
    );
  }

  // GRANT ACCESS TO PROTECTED ROUTE
  req.user = freshUser;
  res.locals.user = freshUser;

  next();
});

exports.restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return next(
        new AppError("You do not have permission to perform this action", 403),
      );
    }

    next();
  };
};

exports.forgotPassword = catchAsync(async (req, res, next) => {
  //get user from the email
  const user = await User.findOne({ email: req.body.email });
  if (!user) {
    return next(new AppError("There is no user with this email address", 404));
  }
  //generate token
  const resetToken = user.createPasswordResetToken();
  // console.log("Token:", resetToken);
  // console.log({ resetToken: resetToken });
  await user.save({ validateBeforeSave: false });

  //send it to the email of user
  try {
    // await sendEmail({
    //     email:user.email,
    //     subject:'Your password reset token (valid for 10 minutes)',
    //     message
    // });
    const resetUrl = `${req.protocol}://${req.get("host")}/api/v1/users/resetPassword/${resetToken}`;
    await new Email(user, resetUrl).sendPasswordReset();
  } catch (err) {
    (user.passwordResetToken = undefined),
      (user.passwordResetExpiresAt = undefined),
      await user.save({ validateBeforeSave: false });
    // console.log(err);
    return next(
      new AppError(
        "There was an error sending the email. Try again later",
        500,
      ),
    );
  }

  res.status(200).json({
    status: "success",
    message: "Token sent to email",
  });
});

exports.resetPassword = catchAsync(async (req, res, next) => {
  //get user from token
  const hashedToken = crypto
    .createHash("sha256")
    .update(req.params.token)
    .digest("hex");

  const user = await User.findOne({
    passwordResetToken: hashedToken,
    passwordResetExpiresAt: { $gt: Date.now() },
  });

  //set the new password if token is valid and user exists
  if (!user) {
    return next(new AppError("Token is invalid or has expired", 400));
  }
  user.password = req.body.password;
  user.passwordConfirm = req.body.passwordConfirm;
  user.passwordResetToken = undefined;
  user.passwordResetExpiresAt = undefined;
  await user.save();

  //update changedPasswordAt property

  //log the user,send jwt
  createSendToken(user, 200, req, res);
});

exports.updatePassword = catchAsync(async (req, res, next) => {
  //get the user
  const user = await User.findById(req.user.id).select("+password");
  //check if posted password is correct
  if (!(await user.correctPassword(req.body.passwordCurrent, user.password))) {
    return next(new AppError("Your current password is incorrect", 401));
  }
  //update
  user.password = req.body.password;
  user.passwordConfirm = req.body.passwordConfirm;
  await user.save();
  //log in user
  createSendToken(user, 200, req, res);
});
