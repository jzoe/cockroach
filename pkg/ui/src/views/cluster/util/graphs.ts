import React from "react";
import _ from "lodash";
import * as nvd3 from "nvd3";
import * as d3 from "d3";
import moment from "moment";

import * as protos from "src/js/protos";
import { NanoToMilli } from "src/util/convert";
import { Bytes, ComputePrefixExponent, ComputeByteScale, Duration } from "src/util/format";

import {
  MetricProps, AxisProps, AxisUnits, QueryTimeInfo,
} from "src/views/shared/components/metricQuery";

type TSResponse = protos.cockroach.ts.tspb.TimeSeriesQueryResponse;

// Global set of colors for graph series.
const seriesPalette = [
  "#5F6C87", "#F2BE2C", "#F16969", "#4E9FD1", "#49D990", "#D77FBF", "#87326D", "#A3415B",
  "#B59153", "#C9DB6D", "#203D9B", "#748BF2", "#91C8F2", "#FF9696", "#EF843C", "#DCCD4B",
];

// Chart margins to match design.
export const CHART_MARGINS: nvd3.Margin = {top: 30, right: 20, bottom: 20, left: 55};

// Maximum number of series we will show in the legend. If there are more we hide the legend.
const MAX_LEGEND_SERIES: number = 4;

/**
 * AxisRange implements functionality to compute the range of points being
 * displayed on an axis.
 */
class AxisRange {
  public min: number = Infinity;
  public max: number = -Infinity;

  // addPoints adds values. It will extend the max/min of the domain if any
  // values are lower/higher than the current max/min respectively.
  addPoints(values: number[]) {
    // Discard infinity values created by #12349
    // TODO(mrtracy): remove when this issue is fixed.
    _.pull(values, Infinity);
    this.min = Math.min(this.min, ...values);
    this.max = Math.max(this.max, ...values);
  }
}

/**
 * AxisDomain is a class that describes the domain of a graph axis; this
 * includes the minimum/maximum extend, tick values, and formatting information
 * for axis values as displayed in various contexts.
 */
class AxisDomain {
  // the minimum value representing the bottom of the axis.
  min: number = 0;
  // the maximum value representing the top of the axis.
  max: number = 1;
  // numbers at which an intermediate tick should be displayed on the axis.
  ticks: number[] = [0, 1];
  // label returns the label for the axis.
  label: string = "";
  // tickFormat returns a function used to format the tick values for display.
  tickFormat: (n: number) => string = _.identity;
  // guideFormat returns a function used to format the axis values in the
  // chart's interactive guideline.
  guideFormat: (n: number) => string = _.identity;

  // constructs a new AxisRange with the given minimum and maximum value, with
  // ticks placed at intervals of the given increment in between the min and
  // max. Ticks are always "aligned" to values that are even multiples of
  // increment. Min and max are also aligned by default - the aligned min will
  // be <= the provided min, while the aligned max will be >= the provided max.
  constructor(min: number, max: number, increment: number, alignMinMax: boolean = true) {
    if (alignMinMax) {
      this.min = min - min % increment;
      this.max = max - max % increment + increment;
    } else {
      this.min = min;
      this.max = max;
    }

    this.ticks = [];
    for (let nextTick = min - min % increment + increment;
         nextTick < this.max;
         nextTick += increment) {
      this.ticks.push(nextTick);
    }
  }

  domain() {
    return [this.min, this.max];
  }
}

const countIncrementTable = [0.1, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1.0];

// computeNormalizedIncrement computes a human-friendly increment between tick
// values on an axis with a range of the given size. The provided size is taken
// to be the minimum range needed to display all values present on the axis.
// The increment is computed by dividing this minimum range into the correct
// number of segments for the supplied tick count, and then increasing this
// increment to the nearest human-friendly increment.
//
// "Human-friendly" increments are taken from the supplied countIncrementTable,
// which should include decimal values between 0 and 1.
function computeNormalizedIncrement(
  range: number, tickCount: number, incrementTbl: number[] = countIncrementTable,
) {
  if (range === 0) {
    throw new Error("cannot compute tick increment with zero range");
  }

  let rawIncrement = range / (tickCount + 1);
  // Compute X such that 0 <= rawIncrement/10^x <= 1
  let x = 0;
  while (rawIncrement > 1) {
    x++;
    rawIncrement = rawIncrement / 10;
  }
  const normalizedIncrementIdx = _.sortedIndex(incrementTbl, rawIncrement);
  return incrementTbl[normalizedIncrementIdx] * Math.pow(10, x);
}

function ComputeCountAxisDomain(
  min: number, max: number, tickCount: number,
): AxisDomain {
  const range = max - min;
  const increment = computeNormalizedIncrement(range, tickCount);
  const axisDomain = new AxisDomain(min, max, increment);

  // If the tick increment is fractional (e.g. 0.2), we display a decimal
  // point. For non-fractional increments, we display with no decimal points
  // but with a metric prefix for large numbers (i.e. 1000 will display as "1k")
  if (Math.floor(increment) !== increment) {
      axisDomain.tickFormat = d3.format(".1f");
  } else {
      axisDomain.tickFormat = d3.format("s");
  }

  // For numbers larger than 1, the tooltip displays fractional values with
  // metric multiplicative prefixes (e.g. Kilo, Mega, Giga). For numbers smaller
  // than 1, we simply display the fractional value without converting to a
  // fractional metric prefix; this is because the use of fractional metric
  // prefixes (i.e. milli, micro, nano) have proved confusing to users.
  const metricFormat = d3.format(".4s");
  const decimalFormat = d3.format(".4f");
  axisDomain.guideFormat = (n: number) => {
    if (n < 1) {
      return decimalFormat(n);
    }
    return metricFormat(n);
  };
  axisDomain.label = "count";
  return axisDomain;
}

function ComputeByteAxisDomain(
  min: number, max: number, tickCount: number,
): AxisDomain {
  // Compute an appropriate unit for the maximum value to be displayed.
  const scale = ComputeByteScale(max);
  const prefixFactor = scale.value;

  // Compute increment on min/max after conversion to the appropriate prefix unit.
  const increment = computeNormalizedIncrement(max / prefixFactor - min / prefixFactor, tickCount);

  // Create axis domain by multiplying computed increment by prefix factor.
  const axisDomain = new AxisDomain(min, max, increment * prefixFactor);

  // Apply the correct label to the axis.
  axisDomain.label = scale.units;

  // Format ticks to display as the correct prefix unit.
  let unitFormat: (v: number) => string;
  if (Math.floor(increment) !== increment) {
      unitFormat = d3.format(".1f");
  } else {
      unitFormat = d3.format("s");
  }
  axisDomain.tickFormat = (v: number) => {
    return unitFormat(v / prefixFactor);
  };

  axisDomain.guideFormat = Bytes;
  return axisDomain;
}

const durationLabels = ["nanoseconds", "microseconds", "milliseconds", "seconds"];

function ComputeDurationAxisDomain(
  min: number, max: number, tickCount: number,
): AxisDomain {
  const prefixExponent = ComputePrefixExponent(max, 1000, durationLabels);
  const prefixFactor = Math.pow(1000, prefixExponent);

  // Compute increment on min/max after conversion to the appropriate prefix unit.
  const increment = computeNormalizedIncrement(max / prefixFactor - min / prefixFactor, tickCount);

  // Create axis domain by multiplying computed increment by prefix factor.
  const axisDomain = new AxisDomain(min, max, increment * prefixFactor);

  // Apply the correct label to the axis.
  axisDomain.label = durationLabels[prefixExponent];

  // Format ticks to display as the correct prefix unit.
  let unitFormat: (v: number) => string;
  if (Math.floor(increment) !== increment) {
      unitFormat = d3.format(".1f");
  } else {
      unitFormat = d3.format("s");
  }
  axisDomain.tickFormat = (v: number) => {
    return unitFormat(v / prefixFactor);
  };

  axisDomain.guideFormat = Duration;
  return axisDomain;
}

const percentIncrementTable = [0.25, 0.5, 0.75, 1.0];

function ComputePercentageAxisDomain(
  min: number, max: number, tickCount: number,
) {
  const range = max - min;
  const increment = computeNormalizedIncrement(range, tickCount, percentIncrementTable);
  const axisDomain = new AxisDomain(min, max, increment);
  axisDomain.label = "percentage";
  axisDomain.tickFormat = d3.format(".0%");
  axisDomain.guideFormat = d3.format(".2%");
  return axisDomain;
}

const timeIncrementDurations = [
  moment.duration(1, "m"),
  moment.duration(5, "m"),
  moment.duration(10, "m"),
  moment.duration(15, "m"),
  moment.duration(30, "m"),
  moment.duration(1, "h"),
  moment.duration(2, "h"),
  moment.duration(3, "h"),
  moment.duration(6, "h"),
  moment.duration(12, "h"),
  moment.duration(24, "h"),
  moment.duration(1, "week"),
];
const timeIncrements = _.map(timeIncrementDurations, (inc) => inc.asMilliseconds());

function ComputeTimeAxisDomain(
  min: number, max: number, tickCount: number,
): AxisDomain {
  // Compute increment; for time scales, this is taken from a table of allowed
  // values.
  let increment = 0;
  {
    const rawIncrement = (max - min) / (tickCount + 1);
    // Compute X such that 0 <= rawIncrement/10^x <= 1
    const tbl = timeIncrements;
    let normalizedIncrementIdx = _.sortedIndex(tbl, rawIncrement);
    if (normalizedIncrementIdx === tbl.length) {
      normalizedIncrementIdx--;
    }
    increment = tbl[normalizedIncrementIdx];
  }

  // Do not normalize min/max for time axis.
  const axisDomain = new AxisDomain(min, max, increment, false);

  axisDomain.label = "time";

  let tickDateFormatter: (d: Date) => string;
  if (increment < moment.duration(24, "hours").asMilliseconds()) {
    tickDateFormatter = d3.time.format.utc("%H:%M");
  } else {
    tickDateFormatter = d3.time.format.utc("%m/%d %H:%M");
  }
  axisDomain.tickFormat = (n: number) => {
    return tickDateFormatter(new Date(n));
  };

  axisDomain.guideFormat = (num) => {
    return moment(num).utc().format("HH:mm:ss [<span class=\"legend-subtext\">on</span>] MMM Do, YYYY");
  };
  return axisDomain;
}

type formattedDatum = {
  values: protos.cockroach.ts.tspb.TimeSeriesDatapoint$Properties,
  key: string,
  area: boolean,
  fillOpacity: number,
};

/**
 * ProcessDataPoints is a helper function to process graph data from the server
 * into a format appropriate for display on an NVD3 graph. This includes the
 * computation of domains and ticks for all axes.
 */
function ProcessDataPoints(
  metrics: React.ReactElement<MetricProps>[],
  axis: React.ReactElement<AxisProps>,
  data: TSResponse,
  timeInfo: QueryTimeInfo,
) {
  const yAxisRange = new AxisRange();
  const xAxisRange = new AxisRange();

  const formattedData: formattedDatum[] = [];

  _.each(metrics, (s, idx) => {
    const result = data.results[idx];
    if (result) {
      yAxisRange.addPoints(_.map(result.datapoints, (dp) => dp.value));
      xAxisRange.addPoints(_.map([timeInfo.start.toNumber(), timeInfo.end.toNumber()], NanoToMilli));

      // Drop any returned points at the beginning that have a lower timestamp
      // than the explicitly queried domain. This works around a bug in NVD3
      // which causes the interactive guideline to highlight the wrong points.
      // https://github.com/novus/nvd3/issues/1913
      const datapoints = _.dropWhile(result.datapoints, (dp) => {
        return NanoToMilli(dp.timestamp_nanos.toNumber()) < xAxisRange.min;
      });

      formattedData.push({
        values: datapoints,
        key: s.props.title || s.props.name,
        area: true,
        fillOpacity: .1,
      });
    }
  });

  if (_.isNumber(axis.props.yLow)) {
    yAxisRange.addPoints([axis.props.yLow]);
  }
  if (_.isNumber(axis.props.yHigh)) {
    yAxisRange.addPoints([axis.props.yHigh]);
  }

  let yAxisDomain: AxisDomain;
  switch (axis.props.units) {
    case AxisUnits.Bytes:
      yAxisDomain = ComputeByteAxisDomain(yAxisRange.min, yAxisRange.max, 3);
      break;
    case AxisUnits.Duration:
      yAxisDomain = ComputeDurationAxisDomain(yAxisRange.min, yAxisRange.max, 3);
      break;
    case AxisUnits.Percentage:
      yAxisDomain = ComputePercentageAxisDomain(yAxisRange.min, yAxisRange.max, 3);
      break;
    default:
      yAxisDomain = ComputeCountAxisDomain(yAxisRange.min, yAxisRange.max, 3);
  }
  const xAxisDomain = ComputeTimeAxisDomain(xAxisRange.min, xAxisRange.max, 10);

  return {
    formattedData,
    yAxisDomain,
    xAxisDomain,
  };
}

export function InitLineChart(chart: nvd3.LineChart) {
    chart
      .x((d: protos.cockroach.ts.tspb.TimeSeriesDatapoint) => new Date(NanoToMilli(d && d.timestamp_nanos.toNumber())))
      .y((d: protos.cockroach.ts.tspb.TimeSeriesDatapoint) => d && d.value)
      .useInteractiveGuideline(true)
      .showLegend(true)
      .showYAxis(true)
      .color(seriesPalette)
      .margin(CHART_MARGINS);
    chart.xAxis
      .showMaxMin(false);
    chart.yAxis
      .showMaxMin(true);
}

/**
 * ProcessDataPoints is a helper function to process graph data from the server
 * into a format appropriate for display on an NVD3 graph. This includes the
 * computation of domains and ticks for all axes.
 */
export function ConfigureLineChart(
  chart: nvd3.LineChart,
  svgEl: SVGElement,
  metrics: React.ReactElement<MetricProps>[],
  axis: React.ReactElement<AxisProps>,
  data: TSResponse,
  timeInfo: QueryTimeInfo,
  hoverTime?: moment.Moment,
) {
  chart.showLegend(metrics.length > 1 && metrics.length <= MAX_LEGEND_SERIES);
  let formattedData: formattedDatum[];
  let xAxisDomain, yAxisDomain: AxisDomain;

  if (data) {
    const processed = ProcessDataPoints(metrics, axis, data, timeInfo);
    formattedData = processed.formattedData;
    xAxisDomain = processed.xAxisDomain;
    yAxisDomain = processed.yAxisDomain;

    chart.yDomain(yAxisDomain.domain());
    if (axis.props.label) {
      chart.yAxis.axisLabel(`${axis.props.label} (${yAxisDomain.label})`);
    } else {
      chart.yAxis.axisLabel(yAxisDomain.label);
    }
    chart.xDomain(xAxisDomain.domain());

    // This is ridiculous, but this NVD3 setting appears to be a relative
    // adjustment to a constant pixel distance.
    chart.yAxis.axisLabelDistance(-10);

    chart.yAxis.tickFormat(yAxisDomain.tickFormat);
    chart.interactiveLayer.tooltip.valueFormatter(yAxisDomain.guideFormat);
    chart.xAxis.tickFormat(xAxisDomain.tickFormat);
    chart.interactiveLayer.tooltip.headerFormatter(xAxisDomain.guideFormat);

    // always set the tick values to the lowest axis value, the highest axis
    // value, and one value in between
    chart.yAxis.tickValues(yAxisDomain.ticks);
    chart.xAxis.tickValues(xAxisDomain.ticks);
  }
  try {
    d3.select(svgEl)
      .datum(formattedData)
      .transition().duration(500)
      .call(chart);

    // Reduce radius of circles in the legend, if present. This is done through
    // d3 because it is not exposed as an option by NVD3.
    d3.select(svgEl).selectAll("circle").attr("r", 3);
  } catch (e) {
    console.log("Error rendering graph: ", e);
  }

  const xScale = chart.xAxis.scale();
  const yScale = chart.yAxis.scale();
  const yExtent = data ? [yScale(yAxisDomain.min), yScale(yAxisDomain.max)] : [0, 1];
  updateLinkedGuideline(svgEl, xScale, yExtent, hoverTime);
}

// A tuple of numbers for the minimum and maximum values of an axis.
type Extent = number[];

// updateLinkedGuideline is responsible for maintaining "linked" guidelines on
// all other graphs on the page; a "linked" guideline highlights the same X-axis
// coordinate on different graphs currently visible on the same page. This
// allows the user to visually correlate a single X-axis coordinate across
// multiple visible graphs.
function updateLinkedGuideline(svgEl: SVGElement, x: d3.scale.Linear<number, number>, yExtent: Extent, hoverTime?: moment.Moment) {
  // Construct a data array for use by d3; this allows us to use d3's
  // "enter()/exit()" functions to cleanly add and remove the guideline.
  const data = !_.isNil(hoverTime) ? [x(hoverTime.valueOf())] : [];

  // Linked guideline will be inserted inside of the "nv-wrap" element of the
  // nvd3 graph. This element has several translations applied to it by nvd3
  // which allow us to easily display the linked guideline at the correct
  // position.
  const wrapper = d3.select(svgEl).select(".nv-wrap");
  if (wrapper.empty()) {
    // In cases where no data is available for a chart, it will not have
    // an "nv-wrap" element and thus should not get a linked guideline.
    return;
  }

  const container = wrapper.selectAll("g.linked-guideline__container")
    .data(data);

  // If there is no guideline on the currently hovered graph, data is empty
  // and this exit statement will remove the linked guideline from this graph
  // if it is already present. This occurs, for example, when the user moves
  // the mouse off of a graph.
  container.exit().remove();

  // If there is a guideline on the currently hovered graph, this enter
  // statement will add a linked guideline element to the current graph (if it
  // does not already exist).
  container.enter()
    .append("g")
      .attr("class", "linked-guideline__container")
      .append("line")
        .attr("class", "linked-guideline__line");

  // Update linked guideline (if present) to match the necessary attributes of
  // the current guideline.
  container.select(".linked-guideline__line")
    .attr("x1", (d) => d)
    .attr("x2", (d) => d)
    .attr("y1", () => yExtent[0])
    .attr("y2", () => yExtent[1]);
}
