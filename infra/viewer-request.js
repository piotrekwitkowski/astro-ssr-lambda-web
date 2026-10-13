// CloudFront can't forward the viewer's Host to a Web Function endpoint, so pass it as
// X-Forwarded-Host, overwriting any value the viewer sent. Drop the viewer's X-Forwarded-For
// so CloudFront's own client IP becomes the first entry, which is the one Astro trusts.
function handler(event) {
  var request = event.request;
  request.headers['x-forwarded-host'] = { value: request.headers.host.value };
  delete request.headers['x-forwarded-for'];
  return request;
}
