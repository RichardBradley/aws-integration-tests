# AWS Integration Tests

We've had a number of issues recently where Cloudwatch alarms were misconfigured
so were silently non functional.

For example, using metric "`4xx`" when they should be using "`4XXError`"
or using statistic `Maximum` when it needs to be `Sum` (e.g. for metrics
that emit "1" on each error)

The Cloudwatch system won't give any errors in these cases, it will
just create an alarm that does nothing.

The Cloudwatch docs are fairly inconsistent. 
Metrics are listed only in human-readable html pages in a big table,
there's no type system or auto checking. 
If the docs say that a metric has dimensions `A,B,C`
then in some AWS systems that means `[A], [A, B], [A,B,C]`
and in other AWS systems that means `[A,B,C]` only.

And the only way to be sure is to try it and see,
which is not even possible in a lot of cases where the metric is difficult to trigger
(such as errors in managed systems).

And if you set an alarm that points at a dimension combo that isn't emitted, then it will
do nothing without any error or hint.

I looked for static analysis tools that could detect these but didn't find
any (I did find several terraform static analysis tools, but none covered this).

I have written a unit test that scans Cloudwatch alarms for these issues.

I've posted this dir to https://github.com/RichardBradley/aws-integration-tests , in case others can use it.

This is in use in a private project. I might remember to update here if we
update there.

Use at your own risk.
