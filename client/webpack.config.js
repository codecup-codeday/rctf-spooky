const path = require('path')
const webpack = require('webpack')
const HtmlWebpackPlugin = require('html-webpack-plugin')
const CopyWebpackPlugin = require('copy-webpack-plugin')
const TerserWebpackPlugin = require('terser-webpack-plugin')
const ForkTsCheckerWebpackPlugin = require('fork-ts-checker-webpack-plugin')
const PrefreshWebpackPlugin = require('@prefresh/webpack')

module.exports = (env) => {
  const babelConfig = {
    presets: [
      ['@babel/preset-typescript', {
        isTSX: true,
        allExtensions: true
      }],
      ['@babel/preset-react', {
        pragma: 'jsx',
        pragmaFrag: 'Fragment'
      }],
      ['@babel/preset-env', {
        targets: { esmodules: true }
      }]
    ],
    plugins: [
      ...(env === 'development' ? [
        'react-refresh/babel'
      ] : [])
    ]
  }

  return {
    mode: env,
    entry: './src/index',
    output: {
      path: path.resolve(__dirname, '../dist/client'),
      filename: env === 'development'
        ? 'assets/bundle.js'
        : 'assets/[contenthash].js',
      publicPath: '/'
    },
    devtool: env === 'development' ? 'eval-cheap-module-source-map' : 'source-map',
    plugins: [
      new HtmlWebpackPlugin({
        template: 'index.html',
        scriptLoading: 'defer',
        inject: 'body'
      }),
      new CopyWebpackPlugin({
        patterns: [{
          from: 'src/static',
          to: '.'
        }]
      }),
      new webpack.ProvidePlugin({
        jsx: ['theme-ui', 'jsx'],
        Fragment: ['preact', 'Fragment']
      }),
      new webpack.EnvironmentPlugin({
        NODE_ENV: env
      }),
      new ForkTsCheckerWebpackPlugin(),
      ...(env === 'development' ? [
        new PrefreshWebpackPlugin(),
        new webpack.HotModuleReplacementPlugin()
      ] : [])
    ],
    optimization: {
      minimizer: [
        new TerserWebpackPlugin({
          terserOptions: { output: { comments: false } },
          extractComments: false
        })
      ]
    },
    module: {
      rules: [{
        enforce: 'pre',
        test: /\.[jt]sx?$/,
        exclude: /node_modules/,
        loader: 'eslint-loader'
      }, {
        test: /\.[jt]sx?$/,
        exclude: /node_modules/,
        use: [{
          loader: 'babel-loader',
          options: babelConfig
        }]
      }]
    },
    resolve: {
      extensions: ['.wasm', '.ts', '.tsx', '.mjs', '.js', '.jsx', '.json'],
      alias: {
        react: 'preact/compat'
      }
    },
    devServer: {
      host: '0.0.0.0',
      disableHostCheck: true,
      overlay: {
        errors: true,
        warnings: true
      },
      hot: true,
      historyApiFallback: true,
      proxy: {
        '/api': {
          target: 'http://localhost:3000'
        }
      }
    }
  }
}